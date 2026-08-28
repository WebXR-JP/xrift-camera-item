import { useEffect, useMemo, useState } from 'react'
import type { WebGLRenderer } from 'three'
import type { CameraFeed } from './useCameraFeed'

// 音声トラックは載せないので、コンテナにも音声コーデックを宣言しない。
// 宣言だけして中身が来ないと、プレイヤーによっては待たされたり壊れて見える
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
]

const pickMime = (): string | null => {
  if (typeof MediaRecorder === 'undefined') return null
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m
    } catch {
      /* 実装によっては投げる */
    }
  }
  return null
}

const stamp = (): string => {
  const d = new Date()
  const p = (n: number) => (n < 10 ? '0' + n : '' + n)
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

export interface Recorder {
  supported: boolean
  recording: boolean
  elapsedMs: number
  error: string | null
  /**
   * 録画の開始 / 停止。映像だけで音声は入らない。
   * ボイスチャットの音を取るにはプラットフォームの音声グラフを覗くか
   * navigator.mediaDevices が要るが、どちらもやらない方針にした。
   */
  toggle(feed: CameraFeed): void
  stop(): void
  /** 録画中だけ、GPU から読み戻して HUD と合成する */
  tick(gl: WebGLRenderer, feed: CameraFeed, hud: HTMLCanvasElement | null, nowMs: number): void
  dispose(): void
}

/**
 * ドローン視点をそのまま .webm に落とす。
 *
 * WebGL のレンダーターゲット -> 非同期リードバック -> 2D キャンバス -> captureStream
 * -> MediaRecorder、という経路。リードバックが同期版だと GPU パイプラインが
 * 止まるので readRenderTargetPixelsAsync（WebGL2 の PBO）を使う。
 *
 * 音声は入れない（映像のみの .webm になる）。
 */
export const useRecorder = (fps: number): Recorder => {
  const [recording, setRecording] = useState(false)

  const rec = useMemo<Recorder>(() => {
    const supported =
      typeof MediaRecorder !== 'undefined' &&
      typeof document !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function'

    let out: HTMLCanvasElement | null = null
    let outCtx: CanvasRenderingContext2D | null = null
    let raw: HTMLCanvasElement | null = null
    let rawCtx: CanvasRenderingContext2D | null = null
    let image: ImageData | null = null
    let buffer: Uint8Array | null = null
    let recorder: MediaRecorder | null = null
    let chunks: Blob[] = []
    let startedAt = 0
    let inFlight = false
    let lastGrabAt = -1e9
    let width = 0
    let height = 0

    const ensureCanvases = (w: number, h: number): boolean => {
      if (out && width === w && height === h) return true
      width = w
      height = h
      out = document.createElement('canvas')
      out.width = w
      out.height = h
      outCtx = out.getContext('2d', { alpha: false })
      raw = document.createElement('canvas')
      raw.width = w
      raw.height = h
      rawCtx = raw.getContext('2d')
      if (!outCtx || !rawCtx) return false
      image = rawCtx.createImageData(w, h)
      buffer = new Uint8Array(new ArrayBuffer(w * h * 4))
      return true
    }

    const finish = () => {
      if (chunks.length === 0) return
      try {
        const type = chunks[0].type || 'video/webm'
        const blob = new Blob(chunks, { type })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `xrift-drone-cam-${stamp()}.${type.indexOf('mp4') >= 0 ? 'mp4' : 'webm'}`
        a.rel = 'noopener'
        a.click()
        // 少し待ってから解放しないと保存前に切れる環境がある
        setTimeout(() => URL.revokeObjectURL(url), 30000)
      } catch (e) {
        api.error = e instanceof Error ? e.message : 'download failed'
      }
      chunks = []
    }

    const api: Recorder = {
      supported,
      recording: false,
      elapsedMs: 0,
      error: null,

      toggle: (feed) => {
        if (api.recording) {
          api.stop()
          return
        }
        if (!supported) {
          api.error = 'MediaRecorder unavailable'
          return
        }
        if (!ensureCanvases(feed.width, feed.height)) {
          api.error = 'canvas 2d unavailable'
          return
        }
        const mime = pickMime()
        try {
          const stream = out!.captureStream(fps)
          recorder = mime
            ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 })
            : new MediaRecorder(stream)
          chunks = []
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data)
          }
          recorder.onstop = finish
          recorder.start(1000)
          startedAt = performance.now()
          api.recording = true
          api.error = null
          setRecording(true)
        } catch (e) {
          api.error = e instanceof Error ? e.message : 'record failed'
          recorder = null
        }
      },

      stop: () => {
        if (!api.recording) return
        api.recording = false
        setRecording(false)
        try {
          recorder?.stop()
        } catch {
          /* noop */
        }
        recorder = null
      },

      tick: (gl, feed, hud, nowMs) => {
        if (!api.recording || !outCtx || !rawCtx || !image || !buffer || !out) return
        api.elapsedMs = performance.now() - startedAt

        const interval = 1000 / Math.max(1, fps)
        if (nowMs - lastGrabAt < interval || inFlight) return
        lastGrabAt = nowMs

        const anyGl = gl as unknown as {
          readRenderTargetPixelsAsync?: (
            rt: unknown,
            x: number,
            y: number,
            w: number,
            h: number,
            buf: Uint8Array,
          ) => Promise<unknown>
        }

        const compose = () => {
          if (!outCtx || !rawCtx || !image || !buffer || !out) return
          image.data.set(buffer)
          rawCtx.putImageData(image, 0, 0)
          outCtx.fillStyle = '#000'
          outCtx.fillRect(0, 0, out.width, out.height)
          outCtx.save()
          // WebGL のリードバックは上下が逆
          outCtx.translate(0, out.height)
          outCtx.scale(1, -1)
          outCtx.drawImage(raw!, 0, 0)
          outCtx.restore()
          if (hud) outCtx.drawImage(hud, 0, 0, out.width, out.height)
        }

        try {
          if (typeof anyGl.readRenderTargetPixelsAsync === 'function') {
            inFlight = true
            anyGl
              .readRenderTargetPixelsAsync(feed.target, 0, 0, feed.width, feed.height, buffer)
              .then(() => {
                inFlight = false
                compose()
              })
              .catch(() => {
                inFlight = false
              })
          } else {
            gl.readRenderTargetPixels(feed.target, 0, 0, feed.width, feed.height, buffer)
            compose()
          }
        } catch (e) {
          inFlight = false
          api.error = e instanceof Error ? e.message : 'readback failed'
          api.stop()
        }
      },

      dispose: () => {
        api.stop()
        out = null
        raw = null
        outCtx = null
        rawCtx = null
        image = null
        buffer = null
      },
    }

    return api
  }, [fps])

  // state は再レンダー（タリーランプの色など）を起こすためだけに持っている。
  // 命令側と食い違ったら React 側の値を正とする
  if (recording !== rec.recording) rec.recording = recording

  useEffect(() => () => rec.dispose(), [rec])

  return rec
}
