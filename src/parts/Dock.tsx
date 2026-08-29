import { useEffect, useMemo, type RefObject } from 'react'
import {
  Group,
  Material,
  MeshStandardMaterial,
  RingGeometry,
  type Texture,
} from 'three'
import type { AtlasSlot } from './canvasTexture'
import { labelQuad, mergeParts, partMatrix } from './mergeGeometry'
import { PanelButton } from './PanelButton'

export interface DockProps {
  idPrefix: string
  groupRef: RefObject<Group | null>
  statusTexture: Texture
  /** 全ボタンのラベルが載った共通マテリアル（atlas） */
  labelMaterial: Material
  /** REC ボタンの atlas のコマ */
  labelSlots: AtlasSlot[]
  onRec(): void
  recSupported: boolean
  /** 台座リングのマテリアル（録画中に赤くする） */
  ringRef: { current: MeshStandardMaterial | null }
}

/** 正面に置く REC ボタン。パッドの前側、ステータス画面が見える向きに置く */
const BUTTON_POS: [number, number, number] = [0, 0.078, 0.42]
const BUTTON_SIZE: [number, number, number] = [0.24, 0.055, 0.11]

/**
 * 離着陸パッドと REC ボタン。
 *
 * 撮り方の操作（モード切替・フォーカス・カット）はモニタ下のパネルに集約した。
 * 台座まで操作を置くと操作のたびモニタと台座を行き来することになるので、
 * 台座側は録画の開始・停止だけを受け持つ。押すたび絵が大きく切り替わるのは
 * モニタの前という「見ている人」の前だけでよい、という割り切り。
 */
export const Dock = ({
  idPrefix,
  groupRef,
  statusTexture,
  labelMaterial,
  labelSlots,
  onRec,
  recSupported,
  ringRef,
}: DockProps) => {
  const materials = useMemo(() => {
    const pad = new MeshStandardMaterial({
      color: '#1b1f26',
      metalness: 0.35,
      roughness: 0.7,
    })
    const ring = new MeshStandardMaterial({
      color: '#0e1216',
      emissive: '#2fe3c0',
      emissiveIntensity: 1.2,
      roughness: 0.4,
    })
    const button = new MeshStandardMaterial({
      color: '#2b323c',
      metalness: 0.6,
      roughness: 0.35,
    })
    return { pad, ring, button }
  }, [])

  const geometry = useMemo(() => {
    const [w, h, d] = BUTTON_SIZE
    // REC ボタンの上面に寝かせたラベル。1 枚でよいので 1 メッシュ
    const labels = mergeParts([
      {
        geometry: labelQuad(
          w * 0.92,
          d * 0.92,
          labelSlots[0],
          partMatrix(BUTTON_POS).multiply(partMatrix([0, h / 2 + 0.0012, 0], [-Math.PI / 2, 0, 0])),
        ),
      },
    ], true)
    // 着陸マークの 2 本のリングも同じマテリアルなのでまとめる
    const rings = mergeParts([
      { geometry: new RingGeometry(0.3, 0.35, 32) },
      { geometry: new RingGeometry(0.07, 0.1, 20) },
    ])
    return { labels, rings }
  }, [labelSlots])

  useEffect(
    () => () => {
      geometry.labels.dispose()
      geometry.rings.dispose()
    },
    [geometry],
  )

  useEffect(() => {
    ringRef.current = materials.ring
    return () => {
      ringRef.current = null
      materials.pad.dispose()
      materials.ring.dispose()
      materials.button.dispose()
    }
  }, [materials, ringRef])

  return (
    <group ref={groupRef}>
      {/* 離着陸パッド。床に置くものなので影は落とさない（受けるだけ） */}
      <mesh material={materials.pad} position={[0, 0.025, 0]} receiveShadow>
        <cylinderGeometry args={[0.62, 0.68, 0.05, 28]} />
      </mesh>
      {/* 着陸マーク。REC ボタンより内側に収める */}
      <mesh
        geometry={geometry.rings}
        material={materials.ring}
        position={[0, 0.052, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      />

      {/* ステータス表示 */}
      <mesh position={[0, 0.36, 0.24]} rotation={[-0.6, 0, 0]}>
        <planeGeometry args={[0.9, 0.19]} />
        <meshBasicMaterial map={statusTexture} transparent toneMapped={false} />
      </mesh>

      {/* REC ボタンだけ。それ以外の操作はモニタのパネルへ */}
      <PanelButton
        id={`${idPrefix}-rec`}
        hint={recSupported ? '録画の開始 / 停止（自分の端末に保存）' : 'この環境では録画できません'}
        enabled={recSupported}
        onPress={onRec}
        position={BUTTON_POS}
        size={BUTTON_SIZE}
        material={materials.button}
      />
      <mesh geometry={geometry.labels} material={labelMaterial} />
    </group>
  )
}