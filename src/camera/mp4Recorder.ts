import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

/**
 * WebCodecs (VideoEncoder) + mp4-muxer で .mp4 を録る経路。
 *
 * MediaRecorder は Chrome では video/mp4 をサポートしないため、H.264 エンコードを
 * 自前で行い mp4-muxer でコンテナに詰める。Safari のように MediaRecorder が
 * mp4 を出せる環境では MediaRecorder 経路が優先されるので、ここは使われない。
 *
 * フレームの投入元は録画用の 2D キャンバス（合成済みの絵）で、
 * VideoFrame に包んで encoder へ渡す。時間は performance.now() 起点の
 * マイクロ秒で渡すので、fps 描画の揺れがあっても再生速度は狂わない。
 */

export interface Mp4Session {
  /** フレームを 1 枚投入する（timestamp は performance.now() ミリ秒） */
  add(canvas: HTMLCanvasElement, nowMs: number): void
  /** エンコードを排出して Blob を作る */
  finish(): Promise<Blob | null>
}

const isSupported = (): boolean =>
  typeof window !== 'undefined' &&
  typeof VideoEncoder !== 'undefined' &&
  typeof VideoFrame !== 'undefined'

/** avc1 のプロファイルは幅広い端末で再生できる Baseline 相当（42001f / level 3.1）にしておく */
const CODEC = 'avc1.42001f'

/** 同期版の対応判定。非同期の isConfigSupported を待てない場所向け */
export const mp4SupportedSync = (): boolean => isSupported()

export const createMp4Session = (
  width: number,
  height: number,
  fps: number,
): Mp4Session | null => {
  if (!isSupported()) return null

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })

  let encoder: VideoEncoder | null = null
  let encodeError: string | null = null
  let firstFrameMs = -1
  let frameCount = 0

  try {
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta)
        } catch {
          /* モジュール評価済みのエラーは握り潰して録画を続ける */
        }
      },
      error: (e) => {
        encodeError = e.message
      },
    })
    encoder.configure({
      codec: CODEC,
      width,
      height,
      bitrate: 6_000_000,
      framerate: fps,
      latencyMode: 'quality',
      avc: { format: 'avc' },
    })
  } catch {
    return null
  }

  return {
    add: (canvas, nowMs) => {
      if (!encoder || encoder.state !== 'configured' || encodeError) return
      if (firstFrameMs < 0) firstFrameMs = nowMs
      // VideoFrame の timestamp はマイクロ秒
      const ts = Math.max(0, Math.round((nowMs - firstFrameMs) * 1000))
      let frame: VideoFrame | null = null
      try {
        frame = new VideoFrame(canvas, {
          timestamp: ts,
          duration: Math.round(1_000_000 / Math.max(1, fps)),
        })
        encoder.encode(frame, { keyFrame: frameCount % Math.max(1, fps * 2) === 0 })
        frameCount++
        // キューが溜まりすぎると描画ループを圧迫するので、バックプレッシャーで待つ
        if (encoder.encodeQueueSize > 8) {
          encoder.flush().catch(() => {})
        }
      } catch {
        /* 1 フレームの失敗で録画を止めない */
      } finally {
        frame?.close()
      }
    },

    finish: async () => {
      try {
        if (encoder && encoder.state !== 'closed') {
          await encoder.flush()
          encoder.close()
        }
        if (frameCount === 0 || encodeError) return null
        muxer.finalize()
        const buffer = (muxer.target as ArrayBufferTarget).buffer
        return new Blob([buffer], { type: 'video/mp4' })
      } catch {
        return null
      } finally {
        encoder = null
      }
    },
  }
}