import { Vector3 } from 'three'
import type { ShotPose, Subject } from './types'
import { MOTION, RIG } from './constants'
import { clamp, easeInOut, fitDistance, lerp, wobble } from './math'

/**
 * ショット（カット）のカタログ。
 *
 * すべて純関数で、入力は「被写体の位置」と「カット開始時に確定した乱数列」だけ。
 * 端末をまたいで同じ入力からは同じ絵が出るので、位置を毎フレーム同期しなくても
 * 全員の画面でドローンが同じ場所を飛ぶ。
 */

export interface ShotContext {
  /** カット開始からの経過秒 */
  t: number
  /** 0..1 に正規化した経過 */
  progress: number
  /** カット開始時に確定した乱数列（決定論的） */
  rnd: number[]
  /** フレームに入れる被写体。先頭が主役 */
  cast: Subject[]
  /** その場にいる全員 */
  all: Subject[]
  /** cast の重心（胸の高さ） */
  center: Vector3
  /** cast を含む球の半径 */
  radius: number
  aspect: number
  /** アイテムの設置位置 */
  origin: Vector3
  /** 床の高さ */
  floorY: number
  /** origin からの最大飛行半径 */
  range: number
  minAltitude: number
  maxAltitude: number
  facing: (s: Subject, out: Vector3) => Vector3
}

export interface ShotDef {
  id: string
  /** HUD に出す略号 */
  label: string
  minCast: number
  /** [最短, 最長] 秒 */
  duration: [number, number]
  /** cast 全員をフレームに収めたい（安全制約で寄りすぎたら画角を広げて補正する） */
  frameAll?: boolean
  /** その状況でこのショットをどれくらい選びたいか。0 で候補から外れる */
  weight(all: Subject[], primary: Subject | null, sinceWideMs: number): number
  /** フレームに入れる被写体を選ぶ */
  select(all: Subject[], primary: Subject | null): Subject[]
  pose(ctx: ShotContext, out: ShotPose): void
}

const vA = new Vector3()
const vB = new Vector3()
const vC = new Vector3()

/** center を中心に、方位角 angle・水平距離 dist・高さ y の点 */
const orbitPoint = (
  center: Vector3,
  angle: number,
  dist: number,
  y: number,
  out: Vector3,
): Vector3 => out.set(center.x + Math.sin(angle) * dist, y, center.z + Math.cos(angle) * dist)

/**
 * 距離 d から半径 r を収めるのに必要な縦画角（度）。
 * fitDistance の逆算。安全制約で寄りすぎたときの救済に使う。
 */
export const fitFovDeg = (radius: number, distance: number, margin = 1.2): number =>
  (Math.atan((radius * margin) / Math.max(0.2, distance)) * 2 * 180) / Math.PI

/** 水平面で v に垂直な単位ベクトル */
const perp = (v: Vector3, out: Vector3): Vector3 => out.set(-v.z, 0, v.x).normalize()

/**
 * いちばんよく動いている人。生の速度ではなく平滑化した motion で選ぶ。
 * 誰も動いていなければ null を返す（＝追走ショットの候補なし）。
 */
const moverOf = (all: Subject[]): Subject | null => {
  let best: Subject | null = null
  for (const s of all) if (!best || s.motion > best.motion) best = s
  return best && best.motion > MOTION.IDLE ? best : null
}

const topN = (all: Subject[], n: number): Subject[] =>
  all.slice().sort((a, b) => b.attention - a.attention).slice(0, n)

// ---------------------------------------------------------------------------

export const SHOTS: ShotDef[] = [
  {
    id: 'wide',
    frameAll: true,
    label: 'WS',
    minCast: 1,
    duration: [5, 8],
    weight: (_all, _primary, sinceWideMs) => 0.8 + clamp(sinceWideMs / 30000, 0, 1) * 2.2,
    select: (all) => topN(all, 6),
    pose: (ctx, out) => {
      const angle = ctx.rnd[0] * Math.PI * 2 + ctx.t * 0.05 * (ctx.rnd[1] > 0.5 ? 1 : -1)
      const dist = fitDistance(ctx.radius, 38, ctx.aspect, 1.55)
      const y = ctx.center.y + ctx.radius * 0.55 + 1.8 + ctx.rnd[2] * 1.4
      orbitPoint(ctx.center, angle, dist, y, out.pos)
      out.look.copy(ctx.center)
      out.fov = 38
      out.roll = 0
    },
  },

  {
    id: 'group',
    frameAll: true,
    label: 'MS',
    minCast: 2,
    duration: [4, 7],
    weight: (all) => (all.length < 2 ? 0 : 2.2),
    select: (all) => topN(all, 5),
    pose: (ctx, out) => {
      const angle = ctx.rnd[0] * Math.PI * 2 + Math.sin(ctx.t * 0.22 + ctx.rnd[3] * 6) * 0.22
      const dist = fitDistance(ctx.radius, 45, ctx.aspect, 1.22)
      orbitPoint(ctx.center, angle, dist, ctx.center.y + 0.3, out.pos)
      out.look.copy(ctx.center)
      out.fov = 45
      out.roll = 0
    },
  },

  {
    id: 'closeup',
    label: 'CU',
    minCast: 1,
    duration: [3, 6],
    // 「何人かに見られている人」は寄って撮る価値がある
    weight: (_all, primary) => (primary && primary.lookedAtBy > 0 ? 2.8 : 0.8),
    select: (_all, primary) => (primary ? [primary] : []),
    pose: (ctx, out) => {
      const s = ctx.cast[0]
      ctx.facing(s, vA)
      // 正面ど真ん中は不自然なので 20〜48 度ずらす
      const side = ctx.rnd[1] > 0.5 ? 1 : -1
      const a = (20 + ctx.rnd[2] * 28) * (Math.PI / 180) * side
      vB.set(
        vA.x * Math.cos(a) - vA.z * Math.sin(a),
        0,
        vA.x * Math.sin(a) + vA.z * Math.cos(a),
      )
      const dist = lerp(1.6, 1.25, easeInOut(ctx.progress)) // ゆっくり寄る
      out.pos.copy(s.head).addScaledVector(vB, dist)
      out.pos.y = s.head.y + 0.02 + ctx.rnd[3] * 0.12
      out.look.copy(s.head).addScaledVector(vA, 0.05)
      out.look.y -= 0.06
      out.fov = 34
      out.roll = 0
    },
  },

  {
    id: 'ots',
    label: 'OTS',
    minCast: 2,
    duration: [3.5, 6],
    weight: (all, primary) =>
      all.length >= 2 && primary && primary.lookedAtBy > 0 ? 2.0 : 0.3,
    select: (all, primary) => {
      if (!primary || all.length < 2) return []
      let partner: Subject | null = null
      let bestD = Infinity
      for (const s of all) {
        if (s === primary) continue
        const d = s.chest.distanceTo(primary.chest)
        if (d < bestD) {
          bestD = d
          partner = s
        }
      }
      return partner ? [primary, partner] : []
    },
    pose: (ctx, out) => {
      const a = ctx.cast[0]
      const b = ctx.cast[1] ?? ctx.cast[0]
      vA.subVectors(a.head, b.head).setY(0).normalize()
      perp(vA, vB)
      const side = ctx.rnd[1] > 0.5 ? 1 : -1
      out.pos
        .copy(b.head)
        .addScaledVector(vA, -0.55)
        .addScaledVector(vB, 0.4 * side)
      out.pos.y = b.head.y + 0.14
      out.look.copy(a.head)
      out.fov = 40
      out.roll = 0
    },
  },

  {
    id: 'orbit',
    label: 'ORB',
    minCast: 1,
    duration: [5, 9],
    weight: () => 1.1,
    select: (all, primary) => (primary ? [primary] : topN(all, 3)),
    pose: (ctx, out) => {
      const dir = ctx.rnd[1] > 0.5 ? 1 : -1
      const angle = ctx.rnd[0] * Math.PI * 2 + ctx.t * 0.3 * dir
      const dist = Math.max(2.1, fitDistance(ctx.radius, 40, ctx.aspect, 1.2))
      const y = ctx.center.y + 0.45 + Math.sin(ctx.t * 0.35) * 0.22
      orbitPoint(ctx.center, angle, dist, y, out.pos)
      out.look.copy(ctx.center)
      out.fov = 40
      out.roll = 0.05 * dir
    },
  },

  {
    id: 'crane',
    frameAll: true,
    label: 'CRN',
    minCast: 1,
    duration: [5, 7],
    weight: () => 0.7,
    select: (all) => topN(all, 4),
    pose: (ctx, out) => {
      const angle = ctx.rnd[0] * Math.PI * 2
      const e = easeInOut(ctx.progress)
      const dist = fitDistance(ctx.radius, 42, ctx.aspect, 1.1 + e * 0.6)
      const y = lerp(ctx.floorY + 0.55, ctx.center.y + ctx.radius * 0.9 + 3.2, e)
      orbitPoint(ctx.center, angle, dist, y, out.pos)
      out.look.copy(ctx.center)
      out.fov = 42
      out.roll = 0
    },
  },

  {
    id: 'dolly',
    frameAll: true,
    label: 'DLY',
    minCast: 1,
    duration: [4, 6.5],
    weight: () => 1.0,
    select: (all) => topN(all, 4),
    pose: (ctx, out) => {
      const angle = ctx.rnd[0] * Math.PI * 2
      const dist = fitDistance(ctx.radius, 40, ctx.aspect, 1.2)
      orbitPoint(ctx.center, angle, dist, ctx.center.y + 0.2, out.pos)
      vA.subVectors(ctx.center, out.pos).setY(0).normalize()
      perp(vA, vB)
      const travel = 3.5 + ctx.rnd[2] * 3.5
      const side = ctx.rnd[1] > 0.5 ? 1 : -1
      out.pos.addScaledVector(vB, (easeInOut(ctx.progress) - 0.5) * travel * side)
      out.look.copy(ctx.center)
      out.fov = 40
      out.roll = 0
    },
  },

  {
    id: 'chase',
    label: 'TRK',
    minCast: 1,
    duration: [4, 8],
    weight: (all) => {
      const f = moverOf(all)
      return f && f.motion > MOTION.CHASE_MIN ? 2.2 : 0.12
    },
    select: (all, primary) => {
      const f = moverOf(all)
      if (f && f.motion > MOTION.CHASE_MIN) return [f]
      return primary ? [primary] : []
    },
    pose: (ctx, out) => {
      const s = ctx.cast[0]
      ctx.facing(s, vA)
      const side = (ctx.rnd[1] - 0.5) * 1.2
      perp(vA, vB)
      out.pos
        .copy(s.head)
        .addScaledVector(vA, -(2.2 + ctx.rnd[2] * 1.2))
        .addScaledVector(vB, side)
      out.pos.y = s.head.y + 0.45 + ctx.rnd[3] * 0.4
      out.look.copy(s.head).addScaledVector(vA, 1.6)
      out.fov = 48
      out.roll = 0
    },
  },

  {
    id: 'low',
    label: 'LOW',
    minCast: 1,
    duration: [3, 5],
    weight: () => 0.5,
    select: (all, primary) => (primary ? [primary] : topN(all, 2)),
    pose: (ctx, out) => {
      const s = ctx.cast[0]
      ctx.facing(s, vA)
      const a = (ctx.rnd[0] - 0.5) * 1.6
      vB.set(
        vA.x * Math.cos(a) - vA.z * Math.sin(a),
        0,
        vA.x * Math.sin(a) + vA.z * Math.cos(a),
      )
      out.pos.copy(s.pos).addScaledVector(vB, 1.9 + ctx.rnd[2] * 0.8)
      out.pos.y = ctx.floorY + 0.35
      out.look.copy(s.head)
      out.fov = 44
      out.roll = 0
    },
  },

  {
    id: 'topdown',
    frameAll: true,
    label: 'TOP',
    minCast: 3,
    duration: [4, 6],
    weight: (all) => (all.length >= 3 ? 0.6 : 0),
    select: (all) => topN(all, 8),
    pose: (ctx, out) => {
      const angle = ctx.rnd[0] * Math.PI * 2 + ctx.t * 0.12
      const need = fitDistance(ctx.radius, 45, ctx.aspect, 1.3)
      // 高度制限に当たっても構図が崩れないよう、上げられるところまで上げる
      const y = Math.min(ctx.center.y + need, ctx.origin.y + ctx.maxAltitude - 0.1)
      const dy = Math.max(0.5, y - ctx.center.y)
      // 真上だと roll が定まらないので、必要距離の範囲で少しだけ倒す
      const off = Math.min(need * 0.22, Math.sqrt(Math.max(0.01, need * need - dy * dy)) || need * 0.22)
      orbitPoint(ctx.center, angle, off, y, out.pos)
      out.look.copy(ctx.center)
      out.fov = 45
      out.roll = 0
    },
  },
]

export const SHOT_BY_ID = new Map(SHOTS.map((s) => [s.id, s]))

/** PARK モード用。ドローンが台座の上でホバリングする */
export const parkPose = (ctx: ShotContext, out: ShotPose): void => {
  out.pos.set(
    ctx.origin.x + wobble(ctx.t, 1) * 0.06,
    ctx.origin.y + 1.15 + wobble(ctx.t, 7) * 0.04,
    ctx.origin.z + wobble(ctx.t, 13) * 0.06,
  )
  if (ctx.all.length > 0) {
    out.look.copy(ctx.center)
  } else {
    out.look.set(ctx.origin.x, ctx.origin.y + 1.1, ctx.origin.z - 3)
  }
  out.fov = 45
  out.roll = 0
}

/**
 * どのショットでも共通で守らせる制約。
 * 床下・被写体へのめり込み・設置位置から離れすぎ、をここで潰す。
 */
export const applySafety = (ctx: ShotContext, pose: ShotPose): void => {
  pose.pos.y = clamp(
    pose.pos.y,
    ctx.floorY + ctx.minAltitude,
    ctx.origin.y + ctx.maxAltitude,
  )

  // 設置位置から離れすぎない（水平方向だけ制限する）
  vA.set(pose.pos.x - ctx.origin.x, 0, pose.pos.z - ctx.origin.z)
  const d = vA.length()
  if (d > ctx.range) {
    vA.multiplyScalar(ctx.range / d)
    pose.pos.x = ctx.origin.x + vA.x
    pose.pos.z = ctx.origin.z + vA.z
  }

  // 誰にもぶつからない
  for (const s of ctx.all) {
    vB.subVectors(pose.pos, s.chest)
    const dist = vB.length()
    if (dist < RIG.MIN_SUBJECT_DISTANCE && dist > 1e-4) {
      vB.multiplyScalar(RIG.MIN_SUBJECT_DISTANCE / dist)
      pose.pos.copy(s.chest).add(vB)
      pose.pos.y = Math.max(pose.pos.y, ctx.floorY + ctx.minAltitude)
    }
  }

  // 注視点と同じ場所に居ると回転が定義できない
  vC.subVectors(pose.look, pose.pos)
  if (vC.lengthSq() < 1e-4) pose.look.set(pose.pos.x, pose.pos.y, pose.pos.z - 1)
}

/**
 * 安全制約で被写体に寄りすぎたぶんを画角で取り返す。
 * frameAll のショットで applySafety のあとに呼ぶ。
 */
export const correctFraming = (ctx: ShotContext, pose: ShotPose): void => {
  const d = pose.pos.distanceTo(ctx.center)
  const needed = fitFovDeg(ctx.radius, d, 1.25)
  pose.fov = clamp(Math.max(pose.fov, needed), 20, 78)
}

export { moverOf }
