import { useMemo, useRef } from 'react'
import { Vector3 } from 'three'
import { useUsers } from '@xrift/world-components'
import type { Subject } from './types'
import { MOTION } from './constants'
import { clamp } from './math'

const DEG2RAD = Math.PI / 180
const tmpA = new Vector3()
const tmpB = new Vector3()

export interface SubjectTracker {
  /** 生きている被写体だけが入る。毎フレーム作り直さず中身を差し替える */
  list: Subject[]
  /** list の中心（胸の高さ基準） */
  center: Vector3
  /** center から全員を含む球の半径 */
  radius: number
  localId: string | null
  byId(id: string): Subject | undefined
  positionOf(id: string): Vector3 | null
  /** 被写体の正面方向（水平、正規化済み）を out に書いて返す */
  facing(s: Subject, out: Vector3): Vector3
  update(dt: number): void
}

const makeSubject = (id: string, name: string, isLocal: boolean): Subject => ({
  id,
  name,
  isLocal,
  pos: new Vector3(),
  chest: new Vector3(),
  head: new Vector3(),
  height: 1.6,
  yaw: 0,
  speed: 0,
  isJumping: false,
  motion: 0,
  lookedAtBy: 0,
  filmedMs: 0,
  attention: 0,
  alive: false,
})

/**
 * ワールド内のユーザーを「被写体」に変換して追跡する。
 *
 * 位置は毎フレーム getMovement() から取る（再レンダーは起きない）。
 * 動き・ジャンプ・視線を合成した attention スコアが、ディレクターが主役を選ぶ根拠になる。
 * 音声には一切触れない（プラットフォームに「誰が喋っているか」の API が無く、
 * 音を覗く実装は読み込み順とボイス実装に依存して壊れやすいため）。
 */
export const useSubjects = (): SubjectTracker => {
  const users = useUsers()
  const usersRef = useRef(users)
  usersRef.current = users

  const poolRef = useRef(new Map<string, Subject>())
  // yaw の符号の流儀はプラットフォーム次第なので、移動方向と突き合わせて自動判定する
  const yawVoteRef = useRef(0)

  return useMemo<SubjectTracker>(() => {
    const list: Subject[] = []
    const center = new Vector3()

    const tracker: SubjectTracker = {
      list,
      center,
      radius: 1,
      localId: null,

      byId: (id) => poolRef.current.get(id),

      positionOf: (id) => {
        const s = poolRef.current.get(id)
        return s && s.alive ? s.pos : null
      },

      facing: (s, out) => {
        const flip = yawVoteRef.current < 0 ? -1 : 1
        return out.set(-Math.sin(s.yaw) * flip, 0, -Math.cos(s.yaw) * flip).normalize()
      },

      update: (dt) => {
        const ctx = usersRef.current
        const pool = poolRef.current
        const ids: string[] = []

        for (const s of pool.values()) s.alive = false

        const register = (
          id: string,
          name: string,
          isLocal: boolean,
        ): Subject | null => {
          const movement = isLocal ? ctx.getLocalMovement?.() : ctx.getMovement?.(id)
          if (!movement) return null

          let s = pool.get(id)
          if (!s) {
            s = makeSubject(id, name, isLocal)
            pool.set(id, s)
          }
          s.name = name
          s.isLocal = isLocal
          s.alive = true

          const h = isLocal
            ? ctx.getLocalAvatarHeight?.()
            : ctx.getAvatarHeight?.(id)
          s.height = h?.height ?? 1.6
          const eye = h?.eyeHeight ?? s.height * 0.94

          s.pos.set(movement.position.x, movement.position.y, movement.position.z)
          s.head.set(s.pos.x, s.pos.y + eye, s.pos.z)
          s.chest.set(s.pos.x, s.pos.y + eye * 0.78, s.pos.z)

          const rawYaw = movement.rotation?.yaw ?? 0
          // 度で来る実装もあるので雑に判別する
          s.yaw = Math.abs(rawYaw) > Math.PI * 2 + 0.2 ? rawYaw * DEG2RAD : rawYaw
          s.speed = movement.horizontalSpeed ?? 0
          s.isJumping = !!movement.isJumping

          // yaw の流儀を投票で決める: 歩いている間だけ移動方向と比べる
          if (s.speed > 1.2 && movement.direction) {
            const fx = -Math.sin(s.yaw)
            const fz = -Math.cos(s.yaw)
            const dot = fx * movement.direction.x + fz * movement.direction.z
            yawVoteRef.current = clamp(yawVoteRef.current + dot * dt * 2, -6, 6)
          }

          ids.push(id)
          return s
        }

        const local = ctx.localUser
        tracker.localId = local ? local.id : null
        if (local) register(local.id, local.displayName || 'You', true)
        for (const u of ctx.remoteUsers ?? []) {
          register(u.id, u.displayName || 'Guest', false)
        }

        // --- 被写体リストを詰め直す ------------------------------------
        list.length = 0
        for (const id of ids) {
          const s = pool.get(id)
          if (s) list.push(s)
        }
        for (const [id, s] of pool) {
          if (!s.alive) pool.delete(id)
        }

        const flip = yawVoteRef.current < 0 ? -1 : 1

        for (const s of list) {
          // 動きの平滑化。上がるのは速く・下がるのはゆっくり。
          // 生の speed だと立ち止まった 1 フレームで 0 に落ちてしまい、
          // ACTION モードの主役が点滅する
          const act = clamp(
            s.speed / MOTION.FULL_SPEED + (s.isJumping ? MOTION.JUMP_BONUS : 0),
            0,
            1,
          )
          const tau = act > s.motion ? MOTION.ATTACK : MOTION.RELEASE
          s.motion += (act - s.motion) * (1 - Math.exp(-dt / tau))

          s.lookedAtBy = 0
          s.filmedMs = Math.max(0, s.filmedMs - dt * 1000 * 0.35)
        }

        // --- 視線（誰が誰を見ているか） --------------------------------
        for (const a of list) {
          const fx = -Math.sin(a.yaw) * flip
          const fz = -Math.cos(a.yaw) * flip
          for (const b of list) {
            if (a === b) continue
            tmpA.subVectors(b.chest, a.chest)
            const d = tmpA.length()
            if (d < 0.3 || d > 9) continue
            tmpA.multiplyScalar(1 / d)
            if (fx * tmpA.x + fz * tmpA.z > 0.87) b.lookedAtBy++
          }
        }

        // --- 注目度 -----------------------------------------------------
        // 声を見なくなったぶん、動きと視線（何人がその人を見ているか）が主な手掛かり。
        // 「みんなが見ている人」は、たいてい今その場の中心にいる人
        for (const s of list) {
          s.attention =
            s.motion * 2.4 +
            (s.isJumping ? 0.8 : 0) +
            Math.min(s.lookedAtBy, 3) * 0.9 -
            clamp(s.filmedMs / 12000, 0, 1) * 0.9
        }

        // --- 全体のバウンディング --------------------------------------
        if (list.length > 0) {
          center.set(0, 0, 0)
          for (const s of list) center.add(s.chest)
          center.multiplyScalar(1 / list.length)
          let r = 0
          for (const s of list) {
            tmpB.subVectors(s.chest, center)
            r = Math.max(r, tmpB.length() + s.height * 0.45)
          }
          tracker.radius = Math.max(0.75, r)
        } else {
          tracker.radius = 1
        }
      },
    }

    return tracker
  }, [])
}
