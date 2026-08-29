import { useMemo } from 'react'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type { ShotPose, Subject } from './types'
import { RIG } from './constants'
import { clamp, damp, wobble } from './math'

const UP = new Vector3(0, 1, 0)
const m4 = new Matrix4()
const qTmp = new Quaternion()
const eTmp = new Euler()
const vTmp = new Vector3()
const vTmp2 = new Vector3()

export interface WingRig {
  /** 機体のワールド座標 */
  pos: Vector3
  /** カメラの姿勢 */
  camQuat: Quaternion
  /** 機体の姿勢（バンク・ピッチが入る） */
  bodyQuat: Quaternion
  /** 機体基準でのジンバル姿勢 */
  gimbalQuat: Quaternion
  fov: number
  speed: number
  rotorAngle: number
  /** 割り当てられた被写体が変わったら true を返しつつリセットする */
  reposition(p: ShotPose): void
  update(desired: ShotPose, dt: number, tSec: number): void
}

/**
 * ウィングドローン 1 機ぶんの飛行リグ。
 *
 * メイン機の useDroneRig と同じ「指数補間 + 速度クランプ + バンク + 手ブレ」
 * をしながら、割り当てられた被写体 1 人を追い続ける。乱数は時刻と機体番号から
 * 決定論的に作るので、全クライアントで同じ位置を飛ぶ。
 */
export const useWingRig = (index: number): WingRig => {
  return useMemo<WingRig>(() => {
    const pos = new Vector3()
    const look = new Vector3()
    const vel = new Vector3()
    const smoothVel = new Vector3()
    const prevPos = new Vector3()

    const rig: WingRig = {
      pos,
      camQuat: new Quaternion(),
      bodyQuat: new Quaternion(),
      gimbalQuat: new Quaternion(),
      fov: 45,
      speed: 0,
      rotorAngle: 0,

      reposition: (p) => {
        pos.copy(p.pos)
        look.copy(p.look)
        rig.fov = p.fov
        vel.set(0, 0, 0)
        smoothVel.set(0, 0, 0)
        rig.speed = 0
      },

      update: (desired, dt, tSec) => {
        const step = clamp(dt, 1 / 240, 1 / 15)
        prevPos.copy(pos)

        vTmp.subVectors(desired.pos, pos)
        const dist = vTmp.length()
        const maxSpeed = RIG.MAX_SPEED * (1 + clamp((dist - 5) / 12, 0, 1) * 2)
        const k = 1 - Math.exp(-RIG.POS_LAMBDA * step)
        let move = dist * k
        if (move > maxSpeed * step) move = maxSpeed * step
        if (dist > 1e-5) pos.addScaledVector(vTmp, move / dist)

        const amp = 0.55 * (0.012 + clamp(rig.speed / 8, 0, 1) * 0.03)
        pos.x += wobble(tSec * 1.7, 3 + index * 7) * amp
        pos.y += wobble(tSec * 1.3, 11 + index * 7) * amp * 1.4
        pos.z += wobble(tSec * 1.9, 23 + index * 7) * amp

        look.x = damp(look.x, desired.look.x, RIG.LOOK_LAMBDA, step)
        look.y = damp(look.y, desired.look.y, RIG.LOOK_LAMBDA, step)
        look.z = damp(look.z, desired.look.z, RIG.LOOK_LAMBDA, step)

        rig.fov = damp(rig.fov, desired.fov, RIG.FOV_LAMBDA, step)

        vel.subVectors(pos, prevPos).multiplyScalar(1 / step)
        smoothVel.lerp(vel, clamp(step * 6, 0, 1))
        rig.speed = smoothVel.length()

        m4.lookAt(pos, look, UP)
        rig.camQuat.setFromRotationMatrix(m4)

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

        const right = Math.cos(heading)
        const rightZ = -Math.sin(heading)
        const lateral = smoothVel.x * right + smoothVel.z * rightZ
        const bank = clamp(-lateral / 6, -1, 1) * RIG.MAX_BANK
        const pitch = clamp(planar / 10, 0, 1) * 0.22

        eTmp.set(pitch, heading, bank, 'YXZ')
        qTmp.setFromEuler(eTmp)
        rig.bodyQuat.slerp(qTmp, clamp(step * 5, 0, 1))
        rig.gimbalQuat.copy(rig.bodyQuat).invert().multiply(rig.camQuat)

        rig.rotorAngle =
          (rig.rotorAngle +
            (40 + clamp(rig.speed / RIG.MAX_SPEED, 0, 1) * RIG.MAX_ROTOR) * step) %
          (Math.PI * 2)
      },
    }

    return rig
  }, [index])
}

/** ウィング機 1 機ぶんの理想姿勢。主役 1 人を CU〜MS の距離で捉える */
export const wingDesired = (
  s: Subject,
  index: number,
  tSec: number,
  out: ShotPose,
): void => {
  const yaw = s.yaw
  const angle = index * 2.1 + Math.sin(tSec * 0.23 + index * 1.7) * 0.55 + yaw * 0.3
  const dist = 3.2 + Math.sin(tSec * 0.17 + index * 2.3) * 0.7
  const y = s.chest.y + 0.9 + Math.sin(tSec * 0.3 + index * 3.1) * 0.35
  out.pos.set(
    s.chest.x + Math.sin(angle) * dist,
    y,
    s.chest.z + Math.cos(angle) * dist,
  )
  out.pos.y = Math.max(out.pos.y, 0.9)
  out.look.copy(s.chest)
  out.fov = 40
  out.roll = 0
}