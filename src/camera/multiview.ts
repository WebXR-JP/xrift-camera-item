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
import type { ShotPose, Subject } from './types'

/**
 * モニタ用の 4 分割マルチビュー。
 *
 * このアイテムは「1 機のメインドローン + 3 機のウィングドローン」で構成される。
 * CAM1 はメイン機のプログラム絵、CAM2〜4 はそれぞれ別の参加者を担当中の
 * ウィング機の視点。ウィング機の機体・リグ・被写体の割り当ては Item 側が持ち、
 * ここは「4 台ぶんの絵を 1 枚のレンダーターゲットに並べる」ことだけを担当する。
 *
 * 録画はモニタに映っている系統（CAM1 またはこの 4 分割）をそのまま落とす。
 */

/** 4 分割の CAM2〜4 に割り当てる被写体。主役を除いた人を ID 昇順で並べ、
 *  足りないぶんは重複して埋める（全員の画面で同じ割り当てになる） */
export const assignChannels = (
  primary: Subject | null,
  all: Subject[],
): [Subject | null, Subject | null, Subject | null] => {
  const rest = all
    .filter((s) => s !== primary)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  const pick = (i: number): Subject | null => rest[i] ?? rest[0] ?? primary ?? null
  return [pick(0), pick(1), pick(2)]
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
   * hiddenAll は全チャンネルで消すもの（モニタとメイン機。CAM1 は機載カメラなので
   * 自機が画を塞ぐ）。
   * hiddenSelf は CAM2〜4 で「そのチャンネルを撮っている機体自身」。レンズを載せた
   * 機体が自分の画に映り込まないよう、該当チャンネルの間だけ消す。
   */
  render(
    gl: WebGLRenderer,
    scene: Scene,
    programCam: PerspectiveCamera,
    poses: ShotPose[],
    hiddenAll: Object3D[],
    hiddenSelf: (Object3D | null | undefined)[],
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

      render: (gl, scene, programCam, poses, hiddenAll, hiddenSelf, nowMs) => {
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

        for (let qi = 0; qi < quads.length; qi++) {
          const [cam, x, y] = quads[qi]
          const hideList = hiddenAll.slice()
          if (qi > 0) {
            const selfObj = hiddenSelf[qi - 1]
            if (selfObj) hideList.push(selfObj)
          }
          const restore: boolean[] = []
          for (let i = 0; i < hideList.length; i++) {
            restore.push(hideList[i].visible)
            hideList[i].visible = false
          }
          // ビューポートは gl.setViewport でなくレンダーターゲット側に直接書く。
          // gl.setViewport/gl.setScissor は値にウィンドウの pixelRatio を掛けて
          // しまうため、オフスクリーンでは DPR≠1 の環境で領域がズレて
          // 1 チャンネルが画面全体を覆ってしまう
          target.viewport.set(x, y, quadW, quadH)
          target.scissor.set(x, y, quadW, quadH)
          target.scissorTest = true
          gl.setRenderTarget(target)
          gl.render(scene, cam)
          for (let i = 0; i < hideList.length; i++) hideList[i].visible = restore[i]
        }

        // 次にこのターゲットへ描く誰のためにも、領域を全面に戻しておく
        target.viewport.set(0, 0, width, height)
        target.scissor.set(0, 0, width, height)
        target.scissorTest = false

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