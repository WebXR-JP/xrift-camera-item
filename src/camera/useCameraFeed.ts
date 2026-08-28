import { useEffect, useMemo } from 'react'
import {
  LinearFilter,
  Object3D,
  PerspectiveCamera,
  Scene,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'

export interface CameraFeed {
  target: WebGLRenderTarget
  camera: PerspectiveCamera
  width: number
  height: number
  /**
   * POV パスの目標 fps。遠くのモニタは小さくしか映らないので、
   * Item 側が距離を見て毎フレーム書き換える。
   */
  fps: number
  /** 直近フレームを描画したか（録画側が新しい絵かを知るため） */
  dirty: boolean
  render(gl: WebGLRenderer, scene: Scene, hidden: Object3D[], nowMs: number): boolean
  dispose(): void
}

/**
 * ドローン視点をオフスクリーンに描く。
 *
 * useFrame の priority は 0 のままにしてあるので、R3F 本体の描画は乗っ取らない。
 * ここでは「レンダーターゲットを一時的に差し替えて 1 パス足す」だけ。
 *
 * hidden に渡したオブジェクト（モニタと機体そのもの）はこのパスの間だけ消す。
 * モニタを消さないと、自分の映像を映しているテクスチャに書き込むことになって
 * フィードバックループになる。
 */
export const useCameraFeed = (width: number, height: number, fps: number): CameraFeed => {
  const feed = useMemo<CameraFeed>(() => {
    const target = new WebGLRenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    })
    target.texture.minFilter = LinearFilter
    target.texture.magFilter = LinearFilter
    target.texture.generateMipmaps = false

    const camera = new PerspectiveCamera(45, width / height, 0.05, 800)
    // ドローンは三人称視点なので、一人称専用レイヤ（頭を消す等）は見ない
    camera.layers.set(0)
    camera.layers.enable(10)

    let lastRenderAt = -1e9
    let colorSpaceSet = false

    const api: CameraFeed = {
      target,
      camera,
      width,
      height,
      fps,
      dirty: false,

      render: (gl, scene, hidden, nowMs) => {
        const interval = 1000 / Math.max(1, api.fps)
        if (nowMs - lastRenderAt < interval) {
          api.dirty = false
          return false
        }
        lastRenderAt = nowMs

        if (!colorSpaceSet) {
          // レンダラの出力色空間に合わせる。合わせないとモニタだけ白飛び／暗くなる
          target.texture.colorSpace = gl.outputColorSpace
          colorSpaceSet = true
        }

        const restore: boolean[] = []
        for (let i = 0; i < hidden.length; i++) {
          restore.push(hidden[i].visible)
          hidden[i].visible = false
        }

        const prevTarget = gl.getRenderTarget()
        const prevXr = gl.xr.enabled
        // VR 中は gl.render が XR カメラを使ってしまうので、このパスの間だけ切る
        gl.xr.enabled = false
        gl.setRenderTarget(target)
        gl.render(scene, camera)
        gl.setRenderTarget(prevTarget)
        gl.xr.enabled = prevXr

        for (let i = 0; i < hidden.length; i++) hidden[i].visible = restore[i]

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
