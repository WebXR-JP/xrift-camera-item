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
  /** ボタンの並び順（MODE / NEXT / CUT / REC）に対応する atlas のコマ */
  labelSlots: AtlasSlot[]
  onMode(): void
  onFocusNext(): void
  onCut(): void
  onRec(): void
  recSupported: boolean
  /** 台座リングのマテリアル（録画中に赤くする） */
  ringRef: { current: MeshStandardMaterial | null }
}

/** 前側の弧に並べる。角度（度）と、ボタンの中心までの半径 */
const ARC_RADIUS = 0.47
const ARC_ANGLES = [-39, -13, 13, 39]
const BUTTON_SIZE: [number, number, number] = [0.2, 0.055, 0.145]
const BUTTON_Y = 0.078

/**
 * 離着陸パッドと操作パネル。
 *
 * ボタンは「押すと何が起きるか」を面に書いてある（MODE なら現在のモードと
 * 切り替え先、REC なら録画中かどうか）。押してみないと分からない状態を残さない。
 * 中央は着陸スペースなので、ボタンは前側の弧に逃がしてある。
 */
export const Dock = ({
  idPrefix,
  groupRef,
  statusTexture,
  labelMaterial,
  labelSlots,
  onMode,
  onFocusNext,
  onCut,
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
    // ボタンの上面に寝かせるラベル。4 枚まとめて 1 メッシュ
    const labels = mergeParts(
      ARC_ANGLES.map((deg, i) => {
        const a = (deg * Math.PI) / 180
        const button = partMatrix(
          [Math.sin(a) * ARC_RADIUS, BUTTON_Y, Math.cos(a) * ARC_RADIUS],
          [0, a, 0],
        )
        const onTop = partMatrix([0, h / 2 + 0.0012, 0], [-Math.PI / 2, 0, 0])
        return {
          geometry: labelQuad(w * 0.92, d * 0.92, labelSlots[i], button.multiply(onTop)),
        }
      }),
      true,
    )
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

  const buttons = [
    { key: 'mode', hint: '撮り方を切り替える', onPress: onMode, on: true },
    { key: 'focus', hint: '次の人にフォーカスする', onPress: onFocusNext, on: true },
    { key: 'cut', hint: '次のカットへ切り替える', onPress: onCut, on: true },
    {
      key: 'rec',
      hint: recSupported ? '録画の開始 / 停止（自分の端末に保存）' : 'この環境では録画できません',
      onPress: onRec,
      on: recSupported,
    },
  ]

  return (
    <group ref={groupRef}>
      {/* 離着陸パッド。床に置くものなので影は落とさない（受けるだけ） */}
      <mesh material={materials.pad} position={[0, 0.025, 0]} receiveShadow>
        <cylinderGeometry args={[0.62, 0.68, 0.05, 28]} />
      </mesh>
      {/* 着陸マーク。ボタンの弧より内側に収める */}
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

      {/* 操作ボタン。文字は下の 1 メッシュがまとめて描く */}
      {buttons.map((b, i) => {
        const a = (ARC_ANGLES[i] * Math.PI) / 180
        return (
          <PanelButton
            key={b.key}
            id={`${idPrefix}-${b.key}`}
            hint={b.hint}
            enabled={b.on}
            onPress={b.onPress}
            position={[Math.sin(a) * ARC_RADIUS, BUTTON_Y, Math.cos(a) * ARC_RADIUS]}
            rotation={[0, a, 0]}
            size={BUTTON_SIZE}
            material={materials.button}
          />
        )
      })}
      <mesh geometry={geometry.labels} material={labelMaterial} />
    </group>
  )
}
