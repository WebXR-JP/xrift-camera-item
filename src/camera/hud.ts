import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three'
import { clamp } from './math'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const SANS =
  'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif'

const WHITE = 'rgba(255,255,255,0.92)'
const DIM = 'rgba(255,255,255,0.34)'
const CYAN = 'rgba(120,235,255,0.95)'
const AMBER = 'rgba(255,196,84,0.95)'
const REC_RED = 'rgba(255,72,72,0.98)'

export interface HudSubject {
  name: string
  /** キャンバス正規化座標（0..1、y は下向き） */
  cx: number
  cy: number
  w: number
  h: number
  /** ならした運動量 0..1 */
  motion: number
  primary: boolean
  /** PIN で指名されている人か */
  pinned: boolean
  /** 画角内に居るか */
  visible: boolean
}

export interface HudModel {
  nowMs: number
  mode: string
  shotLabel: string
  recording: boolean
  recElapsedMs: number
  recSupported: boolean
  fov: number
  speed: number
  altitude: number
  /** 主役のならした運動量 0..1 */
  primaryMotion: number
  /** 追跡している人数 */
  trackedCount: number
  cutFlash: number
  isDirector: boolean
  clockSynced: boolean
  subjects: HudSubject[]
  /** 主役の名前 */
  primaryName: string
  /** 主役が指名されているか */
  primaryPinned: boolean
}

const two = (n: number): string => (n < 10 ? '0' + n : '' + n)

const timecode = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms))
  const f = Math.floor((total % 1000) / (1000 / 30))
  const s = Math.floor(total / 1000) % 60
  const m = Math.floor(total / 60000) % 60
  const h = Math.floor(total / 3600000)
  return `${two(h)}:${two(m)}:${two(s)}:${two(f)}`
}

/**
 * ビューファインダの HUD。素の 2D キャンバスで描いて CanvasTexture にする。
 *
 * これがワールド内のモニタに重なり、録画にもそのまま焼き込まれる。
 * WebGL のシェーダでやるより、テキストと矩形は 2D キャンバスのほうが圧倒的に速い。
 */
export class Viewfinder {
  readonly canvas: HTMLCanvasElement
  readonly texture: CanvasTexture
  private ctx: CanvasRenderingContext2D | null
  private lastPaintAt = -1e9

  constructor(width: number, height: number) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    this.ctx = this.canvas.getContext('2d')
    this.texture = new CanvasTexture(this.canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.minFilter = LinearFilter
    this.texture.magFilter = LinearFilter
    this.texture.generateMipmaps = false
  }

  /** fps を絞って描く。HUD は 12〜15fps で十分に見える */
  paint(model: HudModel, fps = 15): boolean {
    const ctx = this.ctx
    if (!ctx) return false
    if (model.nowMs - this.lastPaintAt < 1000 / fps) return false
    this.lastPaintAt = model.nowMs

    const W = this.canvas.width
    const H = this.canvas.height
    const u = H / 288 // 288px 基準でスケールする

    ctx.clearRect(0, 0, W, H)
    ctx.textBaseline = 'alphabetic'

    this.drawGuides(ctx, W, H, u)
    this.drawTracking(ctx, W, H, u, model)
    this.drawTopBar(ctx, W, H, u, model)
    this.drawBottomBar(ctx, W, H, u, model)
    this.drawCutFlash(ctx, W, H, model)

    this.texture.needsUpdate = true
    return true
  }

  // --- 構図ガイド ---------------------------------------------------------
  private drawGuides(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    u: number,
  ): void {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = Math.max(1, u)
    ctx.beginPath()
    for (let i = 1; i <= 2; i++) {
      ctx.moveTo((W * i) / 3, 0)
      ctx.lineTo((W * i) / 3, H)
      ctx.moveTo(0, (H * i) / 3)
      ctx.lineTo(W, (H * i) / 3)
    }
    ctx.stroke()

    // セーフエリア
    const m = 22 * u
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.setLineDash([6 * u, 6 * u])
    ctx.strokeRect(m, m * 0.75, W - m * 2, H - m * 1.5)
    ctx.setLineDash([])

    // 隅のトンボ
    const c = 16 * u
    ctx.strokeStyle = WHITE
    ctx.lineWidth = Math.max(1.5, 2 * u)
    const corners: [number, number, number, number][] = [
      [8 * u, 8 * u, 1, 1],
      [W - 8 * u, 8 * u, -1, 1],
      [8 * u, H - 8 * u, 1, -1],
      [W - 8 * u, H - 8 * u, -1, -1],
    ]
    ctx.beginPath()
    for (const [x, y, sx, sy] of corners) {
      ctx.moveTo(x + c * sx, y)
      ctx.lineTo(x, y)
      ctx.lineTo(x, y + c * sy)
    }
    ctx.stroke()

    // 中央レティクル
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.lineWidth = Math.max(1, u)
    const r = 7 * u
    ctx.beginPath()
    ctx.moveTo(W / 2 - r, H / 2)
    ctx.lineTo(W / 2 - r * 0.3, H / 2)
    ctx.moveTo(W / 2 + r * 0.3, H / 2)
    ctx.lineTo(W / 2 + r, H / 2)
    ctx.moveTo(W / 2, H / 2 - r)
    ctx.lineTo(W / 2, H / 2 - r * 0.3)
    ctx.moveTo(W / 2, H / 2 + r * 0.3)
    ctx.lineTo(W / 2, H / 2 + r)
    ctx.stroke()
    ctx.restore()
  }

  // --- 被写体トラッキング枠 -----------------------------------------------
  private drawTracking(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    u: number,
    model: HudModel,
  ): void {
    ctx.save()
    for (const s of model.subjects) {
      if (!s.visible) continue
      const x = s.cx * W
      const y = s.cy * H
      const w = clamp(s.w * W, 26 * u, W * 0.9)
      const h = clamp(s.h * H, 34 * u, H * 0.95)
      const x0 = x - w / 2
      const y0 = y - h / 2

      const color = s.primary ? (s.pinned ? AMBER : CYAN) : DIM
      ctx.strokeStyle = color
      ctx.lineWidth = s.primary ? Math.max(1.6, 2.2 * u) : Math.max(1, 1.3 * u)

      // AF 風のコーナーブラケット
      const c = Math.min(w, h) * 0.26
      ctx.beginPath()
      ctx.moveTo(x0, y0 + c)
      ctx.lineTo(x0, y0)
      ctx.lineTo(x0 + c, y0)
      ctx.moveTo(x0 + w - c, y0)
      ctx.lineTo(x0 + w, y0)
      ctx.lineTo(x0 + w, y0 + c)
      ctx.moveTo(x0 + w, y0 + h - c)
      ctx.lineTo(x0 + w, y0 + h)
      ctx.lineTo(x0 + w - c, y0 + h)
      ctx.moveTo(x0 + c, y0 + h)
      ctx.lineTo(x0, y0 + h)
      ctx.lineTo(x0, y0 + h - c)
      ctx.stroke()

      // 名前 + 声量バー
      const label = s.name.length > 14 ? s.name.slice(0, 13) + '…' : s.name
      ctx.font = `${Math.round(10 * u)}px ${SANS}`
      const tw = ctx.measureText(label).width
      const bh = 13 * u
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(x0, y0 + h + 3 * u, tw + 30 * u, bh)
      ctx.fillStyle = color
      ctx.fillText(label, x0 + 3 * u, y0 + h + 3 * u + bh * 0.76)

      const bx = x0 + tw + 8 * u
      const bw = 18 * u
      ctx.fillStyle = 'rgba(255,255,255,0.18)'
      ctx.fillRect(bx, y0 + h + 6 * u, bw, bh * 0.42)
      ctx.fillStyle = color
      ctx.fillRect(bx, y0 + h + 6 * u, bw * clamp(s.motion, 0, 1), bh * 0.42)

      if (s.primary) {
        ctx.font = `600 ${Math.round(9 * u)}px ${MONO}`
        ctx.fillStyle = s.pinned ? AMBER : CYAN
        ctx.fillText(s.pinned ? 'PIN' : 'TRACKING', x0, y0 - 5 * u)
      }
    }
    ctx.restore()
  }

  // --- 上段 ---------------------------------------------------------------
  private drawTopBar(
    ctx: CanvasRenderingContext2D,
    W: number,
    _H: number,
    u: number,
    model: HudModel,
  ): void {
    ctx.save()
    const y = 26 * u
    const x = 26 * u

    if (model.recording) {
      const blink = Math.sin(model.nowMs / 260) > -0.2
      if (blink) {
        ctx.fillStyle = REC_RED
        ctx.beginPath()
        ctx.arc(x + 5 * u, y - 4 * u, 5 * u, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = REC_RED
      ctx.font = `700 ${Math.round(13 * u)}px ${MONO}`
      ctx.fillText('REC', x + 15 * u, y)
      ctx.fillStyle = WHITE
      ctx.font = `${Math.round(13 * u)}px ${MONO}`
      ctx.fillText(timecode(model.recElapsedMs), x + 48 * u, y)
    } else {
      ctx.fillStyle = DIM
      ctx.font = `700 ${Math.round(13 * u)}px ${MONO}`
      ctx.fillText(model.recSupported ? 'STBY' : 'NO REC', x, y)
      ctx.fillStyle = DIM
      ctx.font = `${Math.round(13 * u)}px ${MONO}`
      ctx.fillText(timecode(model.nowMs % 86400000), x + 48 * u, y)
    }

    // 右側: ショット / モード
    ctx.textAlign = 'right'
    ctx.fillStyle = WHITE
    ctx.font = `700 ${Math.round(15 * u)}px ${MONO}`
    ctx.fillText(model.shotLabel, W - 26 * u, y)
    ctx.fillStyle = CYAN
    ctx.font = `600 ${Math.round(10 * u)}px ${MONO}`
    ctx.fillText(model.mode, W - 26 * u, y + 13 * u)
    ctx.restore()
  }

  // --- 下段 ---------------------------------------------------------------
  private drawBottomBar(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    u: number,
    model: HudModel,
  ): void {
    ctx.save()
    const y = H - 22 * u
    const x = 26 * u

    // 主役の運動量メーター
    ctx.fillStyle = DIM
    ctx.font = `${Math.round(9 * u)}px ${MONO}`
    ctx.fillText('MOTION', x, y - 10 * u)

    const segs = 16
    const sw = 4.5 * u
    const gap = 1.6 * u
    const lit = Math.round(clamp(model.primaryMotion, 0, 1) * segs)
    for (let i = 0; i < segs; i++) {
      const on = i < lit
      ctx.fillStyle = on
        ? i > segs - 3
          ? REC_RED
          : i > segs - 6
            ? AMBER
            : 'rgba(120,255,180,0.95)'
        : 'rgba(255,255,255,0.13)'
      ctx.fillRect(x + i * (sw + gap), y - 6 * u, sw, 7 * u)
    }

    ctx.fillStyle = DIM
    ctx.font = `${Math.round(9 * u)}px ${MONO}`
    ctx.fillText(`SUBJ ${model.trackedCount}`, x, y + 8 * u)

    // 主役: 誰を撮っているか / 指名か / 動いているか
    if (model.primaryName) {
      const badge = model.primaryPinned ? 'PIN ' : ''
      const moving = model.primaryMotion > 0.06
      const state = moving ? '  ● 移動中' : ''
      ctx.textAlign = 'center'
      ctx.fillStyle = moving ? AMBER : WHITE
      ctx.font = `${Math.round(11 * u)}px ${SANS}`
      ctx.fillText(`${badge}${model.primaryName}${state}`, W / 2, y + 2 * u)
      ctx.textAlign = 'left'
    }

    // 右下: 数値
    ctx.textAlign = 'right'
    ctx.fillStyle = WHITE
    ctx.font = `${Math.round(11 * u)}px ${MONO}`
    ctx.fillText(
      `${Math.round(model.fov)}° ALT ${model.altitude.toFixed(1)}m ${model.speed.toFixed(1)}m/s`,
      W - 26 * u,
      y,
    )
    ctx.fillStyle = DIM
    ctx.font = `${Math.round(9 * u)}px ${MONO}`
    ctx.fillText(
      `${model.isDirector ? 'DIR' : 'SLAVE'} · CLK ${model.clockSynced ? 'SYNC' : 'LOCAL'}`,
      W - 26 * u,
      y + 10 * u,
    )
    ctx.restore()
  }

  // --- カット時のフラッシュ -----------------------------------------------
  private drawCutFlash(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    model: HudModel,
  ): void {
    if (model.cutFlash <= 0) return
    ctx.save()
    ctx.fillStyle = `rgba(255,255,255,${model.cutFlash * 0.16})`
    ctx.fillRect(0, 0, W, H)
    const bars = 3
    for (let i = 0; i < bars; i++) {
      const y = ((model.nowMs / 7 + i * 97) % H) | 0
      ctx.fillStyle = `rgba(180,240,255,${model.cutFlash * 0.16})`
      ctx.fillRect(0, y, W, 2 + i)
    }
    ctx.restore()
  }

  dispose(): void {
    this.texture.dispose()
    this.ctx = null
  }
}
