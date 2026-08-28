import { useMemo } from 'react'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type { ShotPose } from './types'
import { RIG } from './constants'
import { clamp, damp, wobble } from './math'

const UP = new Vector3(0, 1, 0)
const FORWARD_AXIS = new Vector3(0, 0, 1)
const m4 = new Matrix4()
const qTmp = new Quaternion()
const qRoll = new Quaternion()
const eTmp = new Euler()
const vTmp = new Vector3()
const vTmp2 = new Vector3()

export interface DroneRig {
  /** ドローン本体のワールド座標 */
  pos: Vector3
  /** 実際に見ている点（平滑化後） */
  look: Vector3
  /** カメラの姿勢 */
  camQuat: Quaternion
  /** 機体の姿勢（バンク・ピッチが入る） */
  bodyQuat: Quaternion
  /** 機体基準でのジンバル姿勢（bodyQuat の逆 × camQuat） */
  gimbalQuat: Quaternion
  fov: number
  speed: number
  /** ローターの累積回転 */
  rotorAngle: number
  /** 手ブレの強さ 0..1 */
  shake: number
  update(desired: ShotPose, dt: number, tSec: number, handheld: number, snap: boolean): void
}

/**
 * ショットが指示した「理想の姿勢」に、実際のドローンを追従させる。
 *
 * ここでやっているのは 3 つ。
 * - 指数補間 + 速度クランプ（ワープせずに飛ぶ）
 * - 横加速度に応じたバンク（機体が曲がる方向へ傾く）
 * - 正弦の重ね合わせによる手ブレ（有機的に見せるため）
 *
 * カットのたびにワープさせず「飛んで移動する」ようにしているのは、
 * ワールドの中に実体があるアイテムだから。他の人からはドローンが
 * 次の撮影位置へ飛んでいくのが見える。
 */
export const useDroneRig = (): DroneRig => {
  return useMemo<DroneRig>(() => {
    const pos = new Vector3()
    const look = new Vector3()
    const vel = new Vector3()
    const smoothVel = new Vector3()
    const prevPos = new Vector3()

    const rig: DroneRig = {
      pos,
      look,
      camQuat: new Quaternion(),
      bodyQuat: new Quaternion(),
      gimbalQuat: new Quaternion(),
      fov: 45,
      speed: 0,
      rotorAngle: 0,
      shake: 0,

      update: (desired, dt, tSec, handheld, snap) => {
        const step = clamp(dt, 1 / 240, 1 / 15)

        if (snap) {
          pos.copy(desired.pos)
          look.copy(desired.look)
          rig.fov = desired.fov
          vel.set(0, 0, 0)
          smoothVel.set(0, 0, 0)
        }

        prevPos.copy(pos)

        // --- 位置: 指数補間したうえで最高速度で頭打ちにする ----------------
        vTmp.subVectors(desired.pos, pos)
        const dist = vTmp.length()
        // 遠くへ飛ぶときだけ最高速度を上げる（カット間の移動を間延びさせない）
        const maxSpeed = RIG.MAX_SPEED * (1 + clamp((dist - 5) / 12, 0, 1) * 2)
        const k = 1 - Math.exp(-RIG.POS_LAMBDA * step)
        let move = dist * k
        if (move > maxSpeed * step) move = maxSpeed * step
        if (dist > 1e-5) pos.addScaledVector(vTmp, move / dist)

        // --- 手ブレ -------------------------------------------------------
        const amp = handheld * (0.012 + clamp(rig.speed / 8, 0, 1) * 0.03)
        if (amp > 0) {
          pos.x += wobble(tSec * 1.7, 3) * amp
          pos.y += wobble(tSec * 1.3, 11) * amp * 1.4
          pos.z += wobble(tSec * 1.9, 23) * amp
        }

        // --- 注視点 -------------------------------------------------------
        look.x = damp(look.x, desired.look.x, RIG.LOOK_LAMBDA, step)
        look.y = damp(look.y, desired.look.y, RIG.LOOK_LAMBDA, step)
        look.z = damp(look.z, desired.look.z, RIG.LOOK_LAMBDA, step)
        if (handheld > 0) {
          const la = handheld * 0.02
          look.x += wobble(tSec * 0.9, 31) * la
          look.y += wobble(tSec * 1.1, 41) * la
        }

        rig.fov = damp(rig.fov, desired.fov, RIG.FOV_LAMBDA, step)

        // --- 速度とバンク -------------------------------------------------
        vel.subVectors(pos, prevPos).multiplyScalar(1 / step)
        smoothVel.lerp(vel, clamp(step * 6, 0, 1))
        rig.speed = smoothVel.length()

        // カメラ姿勢
        m4.lookAt(pos, look, UP)
        rig.camQuat.setFromRotationMatrix(m4)
        if (desired.roll !== 0) {
          qRoll.setFromAxisAngle(FORWARD_AXIS, desired.roll)
          rig.camQuat.multiply(qRoll)
        }

        // 機体姿勢: 進行方向へ向き、横加速度ぶんだけロールする
        vTmp2.copy(smoothVel)
        vTmp2.y = 0
        const planar = vTmp2.length()
        let heading: number
        if (planar > 0.25) {
          heading = Math.atan2(-vTmp2.x, -vTmp2.z)
        } else {
          vTmp2.subVectors(look, pos)
          heading = Math.atan2(-vTmp2.x, -vTmp2.z)
        }

        // 進行方向に対する横向き成分 -> バンク角
        const right = Math.cos(heading)
        const rightZ = -Math.sin(heading)
        const lateral = smoothVel.x * right + smoothVel.z * rightZ
        const bank = clamp(-lateral / 6, -1, 1) * RIG.MAX_BANK
        const pitch = clamp(planar / 10, 0, 1) * 0.22

        eTmp.set(pitch, heading, bank, 'YXZ')
        qTmp.setFromEuler(eTmp)
        rig.bodyQuat.slerp(qTmp, clamp(step * 5, 0, 1))
        if (snap) rig.bodyQuat.copy(qTmp)

        // ジンバルは機体の傾きを打ち消してカメラの向きを作る
        rig.gimbalQuat.copy(rig.bodyQuat).invert().multiply(rig.camQuat)

        rig.rotorAngle =
          (rig.rotorAngle +
            (40 + clamp(rig.speed / RIG.MAX_SPEED, 0, 1) * RIG.MAX_ROTOR) * step) %
          (Math.PI * 2)
        rig.shake = handheld
      },
    }

    return rig
  }, [])
}
