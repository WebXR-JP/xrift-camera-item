import { createRef, useEffect, useMemo, type RefObject } from 'react'
import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
} from 'three'
import { mergeParts, partMatrix, type MergePart } from './mergeGeometry'

export interface DroneRefs {
  root: RefObject<Group | null>
  gimbal: RefObject<Group | null>
  rotors: RefObject<Group | null>[]
  /** ローターのブラー。4 枚まとめて 1 メッシュ */
  disc: RefObject<Mesh | null>
  /** 録画タリー用のマテリアル（Drone がマウント時に差し込む） */
  tallyMat: { current: MeshStandardMaterial | null }
  /** ローターのブラー用マテリアル */
  discMat: { current: MeshBasicMaterial | null }
}

export const useDroneRefs = (): DroneRefs =>
  useMemo<DroneRefs>(
    () => ({
      root: createRef<Group>(),
      gimbal: createRef<Group>(),
      rotors: [createRef<Group>(), createRef<Group>(), createRef<Group>(), createRef<Group>()],
      disc: createRef<Mesh>(),
      tallyMat: { current: null },
      discMat: { current: null },
    }),
    [],
  )

const ARM_POSITIONS: [number, number][] = [
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
]
const ARM_R = 0.19

/**
 * 静的なパーツをマテリアルごとに 1 枚のジオメトリへまとめる。
 * 動くもの（ローター・ジンバル）だけ別メッシュのまま残す。
 */
const buildGeometry = () => {
  const trim: MergePart[] = [
    // キャノピー
    {
      geometry: new SphereGeometry(0.115, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      matrix: partMatrix([0, 0.05, -0.02], [0, 0, 0], [1, 0.55, 1.15]),
    },
    // ジンバルのヨーク（機体側に固定）
    {
      geometry: new TorusGeometry(0.055, 0.008, 6, 14, Math.PI),
      matrix: partMatrix([0, -0.075, 0.1], [Math.PI / 2, 0, 0]),
    },
  ]
  const dark: MergePart[] = [
    // バッテリー
    { geometry: new BoxGeometry(0.15, 0.05, 0.18), matrix: partMatrix([0, -0.055, -0.03]) },
  ]
  const discs: MergePart[] = []

  for (const [sx, sz] of ARM_POSITIONS) {
    const ax = sx * ARM_R
    const az = sz * ARM_R
    // モーター
    trim.push({
      geometry: new CylinderGeometry(0.032, 0.036, 0.05, 10),
      matrix: partMatrix([ax, 0.022, az]),
    })
    // アーム
    dark.push({
      geometry: new CylinderGeometry(0.016, 0.016, 0.23, 8),
      matrix: partMatrix([ax * 0.55, 0.004, az * 0.55], [0, Math.atan2(ax, az), Math.PI / 2]),
    })
    // 脚
    dark.push({
      geometry: new CylinderGeometry(0.008, 0.008, 0.12, 6),
      matrix: partMatrix([ax * 0.9, -0.075, az * 0.9]),
    })
    dark.push({
      geometry: new SphereGeometry(0.018, 6, 4),
      matrix: partMatrix([ax * 0.9, -0.135, az * 0.9]),
    })
    // 回転が速いときのブラーディスク
    discs.push({
      geometry: new CircleGeometry(0.098, 16),
      matrix: partMatrix([ax, 0.054, az], [-Math.PI / 2, 0, 0]),
    })
  }

  return {
    shell: new BoxGeometry(0.24, 0.075, 0.32),
    trim: mergeParts(trim),
    dark: mergeParts(dark),
    disc: mergeParts(discs),
    // ローターは 1 枚にまとめて 4 個所で使い回す（ハブもブレードと同じ色にした）
    rotor: mergeParts([
      { geometry: new BoxGeometry(0.19, 0.004, 0.022) },
      { geometry: new BoxGeometry(0.19, 0.004, 0.022), matrix: partMatrix([0, 0, 0], [0, Math.PI / 2, 0]) },
      { geometry: new CylinderGeometry(0.012, 0.012, 0.014, 8) },
    ]),
  }
}

/**
 * 撮影ドローンの見た目。すべてプリミティブの組み合わせで、外部アセットは読まない。
 *
 * 機体（root）とジンバル（gimbal）が別階層になっているのが要点。
 * 機体は進行方向へ傾き、ジンバルがその傾きを打ち消して被写体を狙い続ける。
 * 「カメラがこっちを向いている」ことが他の参加者から見て分かるようにしている。
 *
 * 実光源（PointLight など）は 1 つも置かない。飛び回るアイテムが光源を持つと
 * ワールド側の全マテリアルにライト 1 つ分のコストが乗り、シェーダの再コンパイルも
 * 誘発する。光って見せたい所は emissive のマテリアルだけで済ませている。
 *
 * 静的なパーツはマテリアルごとに 1 メッシュへまとめてある（40 個 → 14 個）。
 * 三角形は 2000 枚も無いので、機体のコストはほぼドローコールの数で決まる。
 * マテリアルも 6 種類だけ（ブレードは機体の暗色と共用）。
 */
export const Drone = ({
  refs,
  scale = 1,
  shadows = true,
}: {
  refs: DroneRefs
  scale?: number
  shadows?: boolean
}) => {
  const geometry = useMemo(buildGeometry, [])

  const materials = useMemo(() => {
    // 環境マップが無いワールドでも黒つぶれしないよう、metalness は控えめにする
    const shell = new MeshStandardMaterial({
      color: '#39404c',
      metalness: 0.25,
      roughness: 0.48,
    })
    const trim = new MeshStandardMaterial({
      color: '#7b8798',
      metalness: 0.45,
      roughness: 0.3,
    })
    const dark = new MeshStandardMaterial({
      color: '#1d222a',
      metalness: 0.15,
      roughness: 0.62,
    })
    const glass = new MeshStandardMaterial({
      color: '#05070c',
      metalness: 1,
      roughness: 0.06,
      emissive: '#0a2030',
      emissiveIntensity: 0.4,
    })
    const disc = new MeshBasicMaterial({
      color: '#aeb8c6',
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      side: DoubleSide,
    })
    const tally = new MeshStandardMaterial({
      color: '#3a0d0d',
      emissive: '#ff2b2b',
      emissiveIntensity: 0.2,
      roughness: 0.4,
    })
    return { shell, trim, dark, glass, disc, tally }
  }, [])

  useEffect(() => {
    refs.tallyMat.current = materials.tally
    refs.discMat.current = materials.disc
    return () => {
      refs.tallyMat.current = null
      refs.discMat.current = null
      for (const m of Object.values(materials)) m.dispose()
    }
  }, [materials, refs])

  useEffect(
    () => () => {
      for (const g of Object.values(geometry)) g.dispose()
    },
    [geometry],
  )

  return (
    <group ref={refs.root} scale={scale} name="cinedrone">
      {/* --- 機体（静的パーツはマテリアルごとに 1 枚） --- */}
      <mesh geometry={geometry.shell} material={materials.shell} castShadow={shadows} />
      <mesh geometry={geometry.trim} material={materials.trim} />
      <mesh geometry={geometry.dark} material={materials.dark} />

      {/* --- ローター --- */}
      {ARM_POSITIONS.map(([sx, sz], i) => (
        <group key={i} ref={refs.rotors[i]} position={[sx * ARM_R, 0.052, sz * ARM_R]}>
          <mesh geometry={geometry.rotor} material={materials.dark} />
        </group>
      ))}
      <mesh ref={refs.disc} geometry={geometry.disc} material={materials.disc} visible={false} />

      {/* タリーランプ（録画中に光る）。機体で唯一光る所 */}
      <mesh material={materials.tally} position={[0, 0.062, -0.14]}>
        <boxGeometry args={[0.07, 0.012, 0.014]} />
      </mesh>

      {/* --- ジンバル + カメラ --- */}
      <group position={[0, -0.075, 0.1]} ref={refs.gimbal}>
        <mesh material={materials.shell}>
          <boxGeometry args={[0.085, 0.075, 0.07]} />
        </mesh>
        {/* レンズ鏡筒。-Z がカメラの前方 */}
        <mesh material={materials.trim} position={[0, 0, -0.06]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.031, 0.034, 0.055, 14]} />
        </mesh>
        <mesh material={materials.dark} position={[0, 0, -0.088]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.036, 0.031, 0.012, 14]} />
        </mesh>
        <mesh material={materials.glass} position={[0, 0, -0.093]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.027, 0.027, 0.004, 14]} />
        </mesh>
        <mesh material={materials.tally} position={[0, 0.045, -0.02]}>
          <boxGeometry args={[0.05, 0.008, 0.01]} />
        </mesh>
      </group>
    </group>
  )
}
