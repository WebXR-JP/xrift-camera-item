import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three'
import { clamp } from '../camera/math'

const SANS =
  'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  return { texture, ctx: canvas.getContext('2d') }
}

/** atlas の 1 コマ。板ポリの uv をこの範囲に差し替えて使う */
export interface AtlasSlot {
  u0: number
  v0: number
  u1: number
  v1: number
}

const ATLAS_COLS = 4
const ATLAS_ROWS = 3
const CELL_W = 256
const CELL_H = 128

/**
 * ボタンの文字を 1 枚のキャンバスにまとめたもの。
 *
 * ラベルごとにテクスチャを作ると、ボタン 12 個で 12 テクスチャ・12 マテリアル・
 * 12 メッシュになる。1 枚に詰めて uv で切り出せば、パネル中のラベルが
 * 「1 テクスチャ・1 マテリアル・1 メッシュ」で描ける。
 *
 * 中身が変わったコマだけ描き直す。ただしテクスチャのアップロードは 1 枚まるごと
 * 走るので、毎フレーム変わるもの（声量メーターなど）はここに入れず TextPanel に置く。
 */
export class PanelAtlas {
  readonly texture: CanvasTexture
  private ctx: CanvasRenderingContext2D | null
  private last: string[] = []

  constructor() {
    const made = makeCanvas(ATLAS_COLS * CELL_W, ATLAS_ROWS * CELL_H)
    this.texture = made.texture
    this.ctx = made.ctx
  }

  /** index 番目のコマの uv 範囲 */
  slot(index: number): AtlasSlot {
    const col = index % ATLAS_COLS
    const row = Math.floor(index / ATLAS_COLS)
    return {
      u0: col / ATLAS_COLS,
      u1: (col + 1) / ATLAS_COLS,
      // キャンバスは上から、uv は下から数える
      v0: 1 - (row + 1) / ATLAS_ROWS,
      v1: 1 - row / ATLAS_ROWS,
    }
  }

  /** コマに 2 行ラベルを描く。1 行目が操作名、2 行目が「押すと何が起きるか」 */
  set(index: number, main: string, sub = '', color = '#e8eef6'): void {
    const key = `${main}\n${sub}\n${color}`
    if (this.last[index] === key) return
    this.last[index] = key
    const ctx = this.ctx
    if (!ctx) return

    const x = (index % ATLAS_COLS) * CELL_W
    const y = Math.floor(index / ATLAS_COLS) * CELL_H
    ctx.clearRect(x, y, CELL_W, CELL_H)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    ctx.fillStyle = color
    ctx.font = `700 ${Math.round(CELL_H * (sub ? 0.33 : 0.4))}px ${MONO}`
    ctx.fillText(main, x + CELL_W / 2, y + CELL_H * (sub ? 0.34 : 0.5), CELL_W * 0.92)

    if (sub) {
      ctx.globalAlpha = 0.66
      ctx.font = `${Math.round(CELL_H * 0.23)}px ${SANS}`
      ctx.fillText(sub, x + CELL_W / 2, y + CELL_H * 0.73, CELL_W * 0.92)
      ctx.globalAlpha = 1
    }
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
    this.ctx = null
  }
}

/** 中身を書き換えられる小さなテキストパネル（ステータス表示用） */
export class TextPanel {
  readonly texture: CanvasTexture
  private ctx: CanvasRenderingContext2D | null
  private last = ''

  constructor(
    private width = 512,
    private height = 128,
  ) {
    const made = makeCanvas(width, height)
    this.texture = made.texture
    this.ctx = made.ctx
  }

  /**
   * 内容が変わったときだけ描き直す。
   * level に 0..1 を渡すと右側に声量メーターを出す。連続値のままだと毎フレーム
   * 描き直しになるので、12 段に量子化してから差分を取る。
   */
  set(main: string, sub: string, accent = '#7fe9ff', level = -1): void {
    const segs = 12
    const step = level < 0 ? -1 : Math.round(clamp(level, 0, 1) * segs)
    const key = `${main}\n${sub}\n${accent}\n${step}`
    if (key === this.last) return
    this.last = key
    const ctx = this.ctx
    if (!ctx) return

    ctx.clearRect(0, 0, this.width, this.height)
    ctx.fillStyle = 'rgba(8,12,16,0.86)'
    ctx.fillRect(0, 0, this.width, this.height)
    ctx.fillStyle = accent
    ctx.fillRect(0, 0, 5, this.height)

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    // メーターを出すぶんだけ文字の幅を譲る
    const meterW = step >= 0 ? this.width * 0.3 : 0
    const textW = this.width - 34 - meterW

    ctx.fillStyle = accent
    ctx.font = `700 ${Math.round(this.height * 0.34)}px ${MONO}`
    ctx.fillText(main, 16, this.height * 0.33, textW)

    ctx.fillStyle = 'rgba(255,255,255,0.62)'
    ctx.font = `${Math.round(this.height * 0.2)}px ${MONO}`
    ctx.fillText(sub, 16, this.height * 0.72, textW)

    if (step >= 0) {
      const bw = this.width * 0.018
      const gap = bw * 0.6
      const total = segs * bw + (segs - 1) * gap
      const x0 = this.width - total - 14
      const bh = this.height * 0.26
      const y = (this.height - bh) / 2
      for (let i = 0; i < segs; i++) {
        ctx.fillStyle = i < step ? accent : 'rgba(255,255,255,0.13)'
        ctx.fillRect(x0 + i * (bw + gap), y, bw, bh)
      }
    }

    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
    this.ctx = null
  }
}
