import type { MeshStandardMaterial } from 'three'
import { Interactable } from '@xrift/world-components'

export interface PanelButtonProps {
  id: string
  /** 近づいたときにプラットフォームが出す操作テキスト */
  hint: string
  enabled?: boolean
  onPress(): void
  position: [number, number, number]
  rotation?: [number, number, number]
  /** 幅・厚み・奥行き（m） */
  size: [number, number, number]
  material: MeshStandardMaterial
}

/**
 * 押せるボタン 1 個。台座とモニタで同じ見た目・同じ当たり方にするために共通化してある。
 *
 * 面の文字はここでは描かない。パネル側が全ボタンぶんのラベルを 1 枚の atlas から
 * 切り出して 1 メッシュにまとめている（ボタンごとに板ポリとマテリアルを持つと、
 * ボタン 12 個で 12 マテリアルになる）。
 *
 * Interactable はプラットフォーム側の操作（デスクトップのカーソルでも VR の手でも）を
 * 受けるが、dev シーンや Triplex では Provider が無い。素の onClick も併せて張って、
 * どちらの環境でも同じように押せるようにしている。
 */
export const PanelButton = ({
  id,
  hint,
  enabled = true,
  onPress,
  position,
  rotation,
  size,
  material,
}: PanelButtonProps) => (
  <Interactable
    id={id}
    type="button"
    enabled={enabled}
    interactionText={hint}
    onInteract={onPress}
  >
    <group
      position={position}
      rotation={rotation}
      onClick={(e) => {
        e.stopPropagation()
        if (enabled) onPress()
      }}
    >
      {/* ボタンは影を落とさない。数が多いうえに影は誰も見ていない */}
      <mesh material={material}>
        <boxGeometry args={size} />
      </mesh>
    </group>
  </Interactable>
)
