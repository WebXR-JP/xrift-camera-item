import { useEffect, useMemo } from 'react'
import {
  LinearFilter,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'
import type { ShotPose } from './types'

/**
 * モニタ用の 4 分割マルチビュー。
 *
 * チャンネルは「このドローンに載っている別のレンズ」。
 * 機体は 1 台のまま、gimbal の主力カメラ（CAM1）のほかに
 * 望遠・広角・機腹の俯瞰カメラが載っている体で、同じ位置から別の画を作る。
 * 絵は全部リグの現在姿勢から計算されるので同期項目は不要で、全員の画面で同じ分割になる。
 *
 * 録画はあくまで CAM1（プログラム）の 1 系統で、マルチビューは録られない。
 */

export interface DroneLensInput {
  /** メインカメラ（CAM1）のワールド位置 */
  pos: Vector3
  /** メインカメラの向き */
  quat: Quaternion
}

/** TEL: 望遠。メインと同じ向きを寄って撮る */
const TEL_FOV = 20
/** WIDE: 広角。メインよりずっと広く */
const WIDE_FOV = 96
/** TOP: 機腹の俯瞰カメラ。真下ではなく前方へ寝かせて落とす（真下だと up が定まらない） */
const TOP_FOV = 58
const TOP_PITCH_DIST = 1.5
const TOP_DROP = 2.8

const fwd = new Vector3()

/**
 * 機体搭載レンズ CAM2〜4 の理想姿勢を out[0..2] へ書く。
 * 位置は CAM1 と共有（同じ機体に載っている）なので、絵の違いは画角と俯瞰だけ。
 */
export const lensPoses = (main: DroneLensInput, out: ShotPose[]): void => {
  fwd.set(0, 0, -1).applyQuaternion(main.quat)
  fwd.y = 0
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1)
  fwd.normalize()

  for (let i = 0; i < out.length; i++) {
    const p = out[i]
    if (i === 0) {
      // CAM2 TEL — メインと同じ軸の望遠レンズ
      p.pos.copy(main.pos)
      p.look.copy(main.pos).addScaledVector(fwd, 10)
      p.fov = TEL_FOV
      p.roll = 0
    } else if (i === 1) {
      // CAM3 WIDE — 周囲込みで掻っさらう広角レンズ
      p.pos.copy(main.pos)
      p.look.copy(main.pos).addScaledVector(fwd, 4)
      p.fov = WIDE_FOV
      p.roll = 0
    } else {
      // CAM4 TOP — 機腹の俯瞰。前方斜め下を見下ろす
      p.pos.copy(main.pos)
      p.look.copy(main.pos).addScaledVector(fwd, TOP_PITCH_DIST)
      p.look.y -= TOP_DROP
      p.fov = TOP_FOV
      p.roll = 0
    }
  }
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
   * poses は [CAM2 TEL, CAM3 WIDE, CAM4 TOP]（CAM1 は programCam をそのまま使う）。
   * hidden は全チャンネルで消すもの（モニタと機体。カメラと機体が同位置のため、
   * 消さないとレンズ自身が画を塞いでしまう）。
   */
  render(
    gl: WebGLRenderer,
    scene: Scene,
    programCam: PerspectiveCamera,
    poses: ShotPose[],
    hidden: Object3D[],
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

      render: (gl, scene, programCam, poses, hidden, nowMs) => {
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
        const quads: [PerspectiveCamera, number, number][] = [
          [programCam, 0, quadH],
          [cams[0], quadW, quadH],
          [cams[1], 0, 0],
          [cams[2], quadW, 0],
        ]

        const prevTarget = gl.getRenderTarget()
        const prevXr = gl.xr.enabled
        // VR 中は gl.render が XR カメラを使ってしまうので、このパスの間だけ切る
        gl.xr.enabled = false

        for (const [cam, x, y] of quads) {
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