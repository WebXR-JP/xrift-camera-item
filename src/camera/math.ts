/**
 * 依存ゼロの数学ユーティリティ。
 * 「全員の画面で同じ絵になる」ことが要件なので、乱数は必ずシード付きにする。
 */

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * フレームレート非依存の指数補間。
 * lambda が大きいほど速く追いつく（lambda=5 でおよそ 0.2 秒の時定数）。
 */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt))

/** ease-in-out。カットの寄り引きに使う */
export const easeInOut = (t: number): number => {
  const c = clamp(t, 0, 1)
  return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2
}

/** -PI..PI に畳む */
export const wrapAngle = (a: number): number => {
  let x = a
  while (x > Math.PI) x -= Math.PI * 2
  while (x < -Math.PI) x += Math.PI * 2
  return x
}

/** 決定論的 PRNG。同じ seed からは全端末で同じ列が出る */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 手持ちカメラ風の揺れ。正弦の重ね合わせなので連続かつ決定論的。
 * 戻り値はおおよそ -1..1。
 */
export const wobble = (t: number, seed: number): number => {
  const s = seed * 0.618
  return (
    Math.sin(t * 1.13 + s) * 0.5 +
    Math.sin(t * 2.31 + s * 3.7) * 0.3 +
    Math.sin(t * 4.77 + s * 1.9) * 0.15 +
    Math.sin(t * 9.13 + s * 5.1) * 0.05
  )
}

/** 重み付き抽選。weights は非負。合計 0 なら -1 */
export const pickWeighted = (weights: number[], rand: number): number => {
  let total = 0
  for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i])
  if (total <= 0) return -1
  let r = rand * total
  for (let i = 0; i < weights.length; i++) {
    r -= Math.max(0, weights[i])
    if (r <= 0) return i
  }
  return weights.length - 1
}

/**
 * 被写体を画角に収めるためのカメラ距離。
 * radius は被写体群を囲む球の半径、margin は 1.0 でぴったり。
 */
export const fitDistance = (
  radius: number,
  fovDeg: number,
  aspect: number,
  margin = 1.25,
): number => {
  const vFov = (fovDeg * Math.PI) / 180
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)
  const half = Math.min(vFov, hFov) / 2
  return (radius * margin) / Math.max(0.05, Math.tan(half))
}
