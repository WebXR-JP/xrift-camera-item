import { useEffect, useMemo, type RefObject } from 'react'
import { Group, Material, MeshStandardMaterial, type Texture } from 'three'
import { BillboardY } from '@xrift/world-components'
import { CAMERA_MODES, type CameraMode, type CutTransition } from '../camera/types'
import type { AtlasSlot } from './canvasTexture'
import { labelQuad, mergeParts, partMatrix } from './mergeGeometry'
import { PanelButton } from './PanelButton'

/** モニタ下の操作 UI。省略すると画面だけになる */
export interface MonitorControls {
  idPrefix: string
  /** 光らせる現在モード */
  mode: CameraMode
  /** カットの切り替わり方。押すと fly ⇄ cut が入れ替わる */
  transition: CutTransition
  /** 全ラベルが載った共通マテリアル（atlas） */
  labelMaterial: Material
  /** チップ（CAMERA_MODES 順）と前後送り・4 分割ボタンのコマ。identity が安定していること */
  slots: { chips: AtlasSlot[]; prev: AtlasSlot; next: AtlasSlot; view: AtlasSlot }
  /** 今フォーカスしている人の名前・状態・声量 */
  focusTexture: Texture
  /** カットの切り替わり方の帯（瞬時 / 移動） */
  transitionTexture: Texture
  onSelectMode(mode: CameraMode): void
  /** +1 で次の人、-1 で前の人 */
  onFocusStep(dir: number): void
  /** モニタの 4 分割表示を切り替える（閲覧者ごと・同期しない） */
  onToggleSplit(): void
  /** カットの切り替わり方を fly ⇄ cut で入れ替える（インスタンス全体に同期） */
  onToggleTransition(): void
}

export interface MonitorProps {
  /** POV パスの間だけ消すためのグループ参照 */
  groupRef: RefObject<Group | null>
  feed: Texture
  hud: Texture
  /** 4 分割表示中。枠線とチャンネル名を重ねる */
  split?: boolean
  width?: number
  height?: number
  /** 台座からの高さ */
  y?: number
  /** 台座からの奥行きオフセット（着陸位置の真上に被らないよう後ろへ置く） */
  z?: number
  billboard?: boolean
  /** 画面の影を落とすか。切ると影パスから外れる */
  shadows?: boolean
  controls?: MonitorControls
}

const CHIP_H = 0.118
const CHIP_D = 0.024
const CHIP_GAP = 0.016
const FOCUS_H = 0.15
const STEP_W = 0.21
/** ボタン前面から文字を浮かせる量 */
const LABEL_Z = 0.018 + CHIP_D / 2 + 0.0012

/**
 * 現場モニタ。ドローンが今撮っている絵と、その上に重ねたビューファインダ HUD を出す。
 *
 * 支柱は持たず、空中に固定する。床に足を着けると台座の真ん中から柱が生えて
 * 操作パネルを跨いでしまうし、設置面が平らでないワールドでは柱だけ浮いたり
 * 埋まったりする。浮かせておけば置き場所を選ばない。
 * 上下に揺らしたりはしない。読む面が動くと文字も HUD も追いにくくなる。
 *
 * 画面の下に操作 UI を付けてある。撮り方を決めるときに見ているのは台座ではなく
 * この画面なので、モードの切り替えとフォーカスの送りはここから直接できるほうが早い。
 * BillboardY の中に入れてあるので、ボタンも常にこちらを向く。
 * ボタン 9 個ぶんの文字は atlas から切り出して 1 メッシュにまとめてある。
 *
 * 映像とHUDを2枚のプレーンに分けているのは、映像はGPU上のレンダーターゲットを
 * そのまま貼れば毎フレーム更新が実質タダなのに対して、HUD は 2D キャンバスなので
 * 15fps くらいに落としたいから。1枚に合成すると安いほうが高いほうに引きずられる。
 */
export const Monitor = ({
  groupRef,
  feed,
  hud,
  split = false,
  width = 1.5,
  height = 1.5 * (9 / 16),
  y = 1.55,
  z = -0.6,
  billboard = true,
  shadows = true,
  controls,
}: MonitorProps) => {
  const materials = useMemo(() => {
    const bezel = new MeshStandardMaterial({
      color: '#15181d',
      metalness: 0.5,
      roughness: 0.55,
    })
    const chip = new MeshStandardMaterial({
      color: '#232a34',
      metalness: 0.45,
      roughness: 0.45,
    })
    // 選択中のチップ。押した結果がひと目で分かるよう、ここだけ光らせる
    const chipOn = new MeshStandardMaterial({
      color: '#0d2b2f',
      emissive: '#2fe3c0',
      emissiveIntensity: 0.85,
      roughness: 0.4,
    })
    // fly（飛んで移動）モード中のトランジションチップ
    const chipFly = new MeshStandardMaterial({
      color: '#2b2413',
      emissive: '#ffb24d',
      emissiveIntensity: 0.55,
      roughness: 0.4,
    })
    return { bezel, chip, chipOn, chipFly }
  }, [])

  useEffect(
    () => () => {
      materials.bezel.dispose()
      materials.chip.dispose()
      materials.chipOn.dispose()
      materials.chipFly.dispose()
    },
    [materials],
  )

  const outerW = width + 0.07
  const bezelBottom = -(height + 0.07) / 2
  const chipY = bezelBottom - 0.022 - CHIP_H / 2
  const viewY = chipY - CHIP_H / 2 - 0.018 - CHIP_H / 2
  const focusY = viewY - CHIP_H / 2 - 0.02 - FOCUS_H / 2
  const chipW = (outerW - CHIP_GAP * (CAMERA_MODES.length - 1)) / CAMERA_MODES.length
  const focusW = outerW - STEP_W * 2 - 0.044
  const stepX = outerW / 2 - STEP_W / 2
  const chipX = (i: number) => -outerW / 2 + chipW / 2 + i * (chipW + CHIP_GAP)
  /** 2 段目（4 分割 / 切替）の左右ボタン幅。中央の帯と同じ寸法 */
  const viewSideW = STEP_W * 1.15

  const slots = controls?.slots
  const labelGeometry = useMemo(() => {
    if (!slots) return null
    const parts = slots.chips.map((slot, i) => ({
      geometry: labelQuad(
        chipW * 0.92,
        CHIP_H * 0.92,
        slot,
        partMatrix([-outerW / 2 + chipW / 2 + i * (chipW + CHIP_GAP), chipY, LABEL_Z]),
      ),
    }))
    const stepH = FOCUS_H * 0.8 * 0.92
    parts.push({
      geometry: labelQuad(
        STEP_W * 0.92,
        stepH,
        slots.prev,
        partMatrix([-(outerW / 2 - STEP_W / 2), focusY, LABEL_Z]),
      ),
    })
    parts.push({
      geometry: labelQuad(
        STEP_W * 0.92,
        stepH,
        slots.next,
        partMatrix([outerW / 2 - STEP_W / 2, focusY, LABEL_Z]),
      ),
    })
    parts.push({
      geometry: labelQuad(
        viewSideW * 0.92,
        CHIP_H * 0.86,
        slots.view,
        partMatrix([-(outerW / 2 - viewSideW / 2), viewY, LABEL_Z]),
      ),
    })
    return mergeParts(parts, true)
  }, [slots, outerW, chipW, chipY, viewY, focusY])

  useEffect(() => () => labelGeometry?.dispose(), [labelGeometry])

  const head = (
    <group>
      <mesh material={materials.bezel} castShadow={shadows}>
        <boxGeometry args={[outerW, height + 0.07, 0.035]} />
      </mesh>
      {/* 映像 */}
      <mesh position={[0, 0, 0.019]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={feed} toneMapped={false} />
      </mesh>
      {/* 4 分割中の区切り線。チャンネル名は HUD 側でなくここに置く（静的でよい） */}
      {split && (
        <group position={[0, 0, 0.021]}>
          <mesh>
            <planeGeometry args={[width, 0.008]} />
            <meshBasicMaterial color="#0a0d10" toneMapped={false} />
          </mesh>
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <planeGeometry args={[width, 0.004]} />
            <meshBasicMaterial color="#0a0d10" toneMapped={false} />
          </mesh>
        </group>
      )}
      {/* HUD */}
      <mesh position={[0, 0, 0.0215]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={hud} transparent depthWrite={false} toneMapped={false} />
      </mesh>

      {controls && labelGeometry && (
        <group>
          {/* 撮り方のチップ。押したものが光る */}
          {CAMERA_MODES.map((m, i) => (
            <PanelButton
              key={m}
              id={`${controls.idPrefix}-m-${m}`}
              hint={m === 'pin' ? '今映っている人に固定する' : 'この撮り方に切り替える'}
              onPress={() => controls.onSelectMode(m)}
              position={[chipX(i), chipY, 0.018]}
              size={[chipW, CHIP_H, CHIP_D]}
              material={controls.mode === m ? materials.chipOn : materials.chip}
            />
          ))}

          {/* 2 段目: 4 分割トグルと、カットの切り替わり方。押すと何になるかは
              ラベル（MODE 行の右）とボタン光で示す */}
          <PanelButton
            id={`${controls.idPrefix}-view-split`}
            hint={split ? '1 画面に戻す' : '4 分割で全カメラを見る'}
            onPress={() => controls.onToggleSplit()}
            position={[-(outerW / 2 - viewSideW / 2), viewY, 0.018]}
            size={[viewSideW, CHIP_H, CHIP_D]}
            material={split ? materials.chipOn : materials.chip}
          />
          <PanelButton
            id={`${controls.idPrefix}-transition`}
            hint={
              controls.transition === 'cut'
                ? 'カットを飛んで移動に戻す'
                : 'カットを瞬時切り替えにする'
            }
            onPress={() => controls.onToggleTransition()}
            position={[outerW / 2 - viewSideW / 2, viewY, 0.018]}
            size={[viewSideW, CHIP_H, CHIP_D]}
            material={
              controls.transition === 'cut' ? materials.chipOn : materials.chipFly
            }
          />
          <mesh position={[0, viewY, 0.02]}>
            <planeGeometry args={[focusW, CHIP_H]} />
            <meshBasicMaterial map={controls.transitionTexture} transparent toneMapped={false} />
          </mesh>

          {/* フォーカスしている人と、その送り */}
          <PanelButton
            id={`${controls.idPrefix}-focus-prev`}
            hint="前の人にフォーカスする"
            onPress={() => controls.onFocusStep(-1)}
            position={[-stepX, focusY, 0.018]}
            size={[STEP_W, FOCUS_H * 0.8, CHIP_D]}
            material={materials.chip}
          />
          <mesh position={[0, focusY, 0.02]}>
            <planeGeometry args={[focusW, FOCUS_H]} />
            <meshBasicMaterial map={controls.focusTexture} transparent toneMapped={false} />
          </mesh>
          <PanelButton
            id={`${controls.idPrefix}-focus-next`}
            hint="次の人にフォーカスする"
            onPress={() => controls.onFocusStep(1)}
            position={[stepX, focusY, 0.018]}
            size={[STEP_W, FOCUS_H * 0.8, CHIP_D]}
            material={materials.chip}
          />

          {/* ボタン 9 個ぶんの文字。atlas から切り出して 1 メッシュ */}
          <mesh geometry={labelGeometry} material={controls.labelMaterial} />
        </group>
      )}
    </group>
  )

  return (
    <group ref={groupRef} position={[0, y, z]} name="cinedrone-monitor">
      {billboard ? <BillboardY>{head}</BillboardY> : head}
    </group>
  )
}
