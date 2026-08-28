import { useEffect, useMemo } from 'react'
import {
  LinearFilter,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { applySafety, type ShotContext } from './shots'
import type { ShotPose } from './types'
import { fitDistance } from './math'
import type { Subject } from './types'

/**
 * モニタ用の 4 分割マルチビュー。
 *
 * CAM1 にメインのプログラム映像、CAM2〜4 に「主役以外の注目度上位の人」を
 * 決定論的に割り当てる。割り当てと絵はサーバ時計と参加者 ID だけから計算するので、
 * 全員の画面で同じ分割になる（新しい同期項目は不要）。
 *
 * 各チャンネルは実在する機体を持たない仮想カメラ。ドローンは 1 台のまま、
 * モニタだけ放送局のマルチビューモニタのように振る舞う。
 * 録画はあくまで CAM1（プログラム）の 1 系統で、マルチビューは録られない。
 */

export type ChannelKind = 'cu' | 'orb' | 'ws'

export interface ChannelSpec {
  kind: ChannelKind
  /** 撮る人。null なら全体画あるいは待機 */
  subject: Subject | null
  /** HUD に出すチャンネル名 */
  label: string
}

/**
 * チャンネルへの割り当て。主役を除いた人を ID 昇順で並べ、
 * CAM2 に CU、CAM3 に ORB、CAM4 は全体画を担う。人が足りなければ
 * 主役へのフォールバックで空きチャンネルを埋める。
 */
export const assignChannels = (
  primary: Subject | null,
  all: Subject[],
): ChannelSpec[] => {
  const pool = all.filter((s) => s !== primary).sort((a, b) => (a.id < b.id ? -1 : 1))
  return [
    { kind: 'cu', subject: pool[0] ?? primary, label: 'CAM2 CU' },
    { kind: 'orb', subject: pool[1] ?? primary, label: 'CAM3 ORB' },
    { kind: 'ws', subject: null, label: 'CAM4 WS' },
  ]
}

const vA = new Vector3()
const vB = new Vector3()
const vC = new Vector3()
const vD = new Vector3()

/** チャンネル 1 個ぶんの理想姿勢。tSec はサーバ時計起点の秒（決定論的） */
export const channelPose = (
  spec: ChannelSpec,
  ctx: ShotContext,
  tSec: number,
  out: ShotPose,
): void => {
  const s = spec.subject ?? ctx.cast[0] ?? null

  if (spec.kind === 'cu' && s) {
    // 寄り。正面ど真ん中を避けて 32 度ずらした絶叫近距離
    ctx.facing(s, vA)
    const a = (32 * Math.PI) / 180
    vB.set(
      vA.x * Math.cos(a) - vA.z * Math.sin(a),
      0,
      vA.x * Math.sin(a) + vA.z * Math.cos(a),
    )
    out.pos.copy(s.head).addScaledVector(vB, 1.45)
    out.pos.y = s.head.y + 0.03
    out.look.copy(s.head)
    out.look.y -= 0.05
    out.fov = 34
  } else if (spec.kind === 'orb' && s) {
    // 回り込み。ゆっくり周回し続ける
    vC.copy(s.chest)
    const angle = tSec * 0.5 + 2.1
    const dist = Math.max(2.2, fitDistance(0.6, 40, ctx.aspect, 1.35))
    out.pos.set(
      vC.x + Math.sin(angle) * dist,
      vC.y + 0.35 + Math.sin(tSec * 0.33) * 0.15,
      vC.z + Math.cos(angle) * dist,
    )
    out.look.copy(vC)
    out.fov = 40
  } else {
    // 全体画（WS）。「その場の全員」を収める。誰も居なければ設置位置の周囲を眺める
    const center = vD
    let radius = ctx.radius
    if (ctx.all.length > 0) {
      center.set(0, 0, 0)
      for (const p of ctx.all) center.add(p.chest)
      center.multiplyScalar(1 / ctx.all.length)
      let r = 0
      for (const p of ctx.all) {
        vB.subVectors(p.chest, center)
        r = Math.max(r, vB.length() + p.height * 0.45)
      }
      radius = Math.max(0.75, r)
    } else {
      center.set(ctx.origin.x, ctx.origin.y + 1.2, ctx.origin.z)
      radius = 2
    }
    const angle = tSec * 0.05
    const dist = fitDistance(radius, 42, ctx.aspect, 1.4)
    out.pos.set(
      center.x + Math.sin(angle) * dist,
      center.y + radius * 0.5 + 1.6,
      center.z + Math.cos(angle) * dist,
    )
    out.look.copy(center)
    out.fov = 42
  }

  out.roll = 0
  applySafety(ctx, out)
}

export interface MultiviewFeed {
  target: WebGLRenderTarget
  texture: Texture
  width: number
  height: number
  /** 4 分割パスの目標 fps。メインより落ちても監視用途には足りる */
  fps: number
  dirty: boolean
  /**
   * 1 枚のレンダーターゲットに 4 つのビューポートを描き分ける。
   * poses は [CAM2, CAM3, CAM4]（CAM1 は programCam をそのまま使う）。
   * hiddenProgram は CAM1 の間だけ消すもの（モニタと機体）、
   * hiddenChannel は全チャンネルで消すもの（モニタ。機体は CAM2〜4 に映ってよい）。
   */
  render(
    gl: WebGLRenderer,
    scene: Scene,
    programCam: PerspectiveCamera,
    poses: ShotPose[],
    hiddenProgram: Object3D[],
    hiddenChannel: Object3D[],
    nowMs: number,
  ): boolean
  dispose(): void
}

/**
 * マルチビュー用のオフスクリーン。
 * scissor を区切って 4 パスに分けるので、autoClear のクリアも各四角の中に収まる。
 */
export const useMultiviewFeed = (
  width: number,
  height: number,
  fps: number,
): MultiviewFeed => {
  const feed = useMemo<MultiviewFeed>(() => {
    const target = new WebGLRenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    })
    target.texture.minFilter = LinearFilter
    target.texture.magFilter = LinearFilter
    target.texture.generateMipmaps = false

    const makeCam = () => {
      const c = new PerspectiveCamera(45, width / height, 0.05, 800)
      // ドローンは三人称視点なので、一人称専用レイヤは見ない
      c.layers.set(0)
      c.layers.enable(10)
      return c
    }
    const cams = [makeCam(), makeCam(), makeCam()]
    const up = new Vector3(0, 1, 0)

    let lastRenderAt = -1e9
    let colorSpaceSet = false

    const api: MultiviewFeed = {
      target,
      texture: target.texture,
      width,
      height,
      fps,
      dirty: false,

      render: (gl, scene, programCam, poses, hiddenProgram, hiddenChannel, nowMs) => {
        const interval = 1000 / Math.max(1, api.fps)
        if (nowMs - lastRenderAt < interval) {
          api.dirty = false
          return false
        }
        lastRenderAt = nowMs

        if (!colorSpaceSet) {
          target.texture.colorSpace = gl.outputColorSpace
          colorSpaceSet = true
        }

        for (let i = 0; i < 3; i++) {
          const cam = cams[i]
          const p = poses[i]
          if (!p) continue
          cam.position.copy(p.pos)
          cam.up.copy(up)
          cam.lookAt(p.look)
          if (Math.abs(cam.fov - p.fov) > 0.01) {
            cam.fov = p.fov
            cam.updateProjectionMatrix()
          }
          cam.updateMatrixWorld(true)
        }

        const quadW = width / 2
        const quadH = height / 2

        // 左上 / 右上 / 左下 / 右下。WebGL のビューポート原点は左下
        const quads: [PerspectiveCamera, number, number, Object3D[]][] = [
          [programCam, 0, quadH, hiddenProgram],
          [cams[0], quadW, quadH, hiddenChannel],
          [cams[1], 0, 0, hiddenChannel],
          [cams[2], quadW, 0, hiddenChannel],
        ]

        const prevTarget = gl.getRenderTarget()
        const prevXr = gl.xr.enabled
        // VR 中は gl.render が XR カメラを使ってしまうので、このパスの間だけ切る
        gl.xr.enabled = false

        for (const [cam, x, y, hidden] of quads) {
          const restore: boolean[] = []
          for (let i = 0; i < hidden.length; i++) {
            restore.push(hidden[i].visible)
            hidden[i].visible = false
          }
          gl.setRenderTarget(target)
          gl.setViewport(x, y, quadW, quadH)
          gl.setScissor(x, y, quadW, quadH)
          gl.setScissorTest(true)
          gl.render(scene, cam)
          gl.setScissorTest(false)
          for (let i = 0; i < hidden.length; i++) hidden[i].visible = restore[i]
        }

        gl.setRenderTarget(prevTarget)
        gl.xr.enabled = prevXr

        api.dirty = true
        return true
      },

      dispose: () => {
        target.dispose()
      },
    }

    return api
  }, [width, height, fps])

  useEffect(() => () => feed.dispose(), [feed])

  return feed
}