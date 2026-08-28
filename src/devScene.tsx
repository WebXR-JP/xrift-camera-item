/**
 * 開発用のテストシーン。本番ビルドには含まれない。
 *
 * プラットフォームが注入するはずの UsersContext を自前で用意して、
 * うろうろ歩き回るダミーの参加者を 4 人立てている。
 * これがないとアイテムに「被写体」が 1 人も居ないので何も検証できない。
 *
 * 疑似発話は決定論的なので、カット割りの挙動は毎回同じ順で再現する。
 */

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Physics } from '@react-three/rapier'
import { Grid } from '@react-three/drei'
import { CanvasTexture, Group, LinearFilter, SRGBColorSpace, Vector3 } from 'three'
import {
  BillboardY,
  XRiftProvider,
  type User,
  type UsersContextValue,
} from '@xrift/world-components'
import type { PlayerMovement } from '@xrift/world-components'
import { Item } from './Item'
/**
 * ダミー参加者の名札。開発シーン専用なので、アイテム側の parts には置かない。
 */
const makeLabelTexture = (
  text: string,
  opts: { width: number; height: number; color: string; background: string; fontSize: number },
): CanvasTexture => {
  const canvas = document.createElement('canvas')
  canvas.width = opts.width
  canvas.height = opts.height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = opts.background
    ctx.fillRect(0, 0, opts.width, opts.height)
    ctx.fillStyle = opts.color
    ctx.font = `700 ${opts.fontSize}px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, opts.width / 2, opts.height / 2, opts.width * 0.92)
  }
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.generateMipmaps = false
  return tex
}

interface Agent {
  id: string
  name: string
  color: string
  ax: number
  az: number
  fx: number
  fz: number
  phase: number
  center: [number, number]
}

const AGENTS: Agent[] = [
  { id: 'dev-aa-you-0001', name: 'あなた', color: '#7fe9ff', ax: 3.4, az: 2.2, fx: 0.19, fz: 0.27, phase: 0.0, center: [0, -1] },
  { id: 'dev-user-0002', name: 'Hoshino', color: '#ffb27f', ax: 2.6, az: 3.1, fx: 0.23, fz: 0.17, phase: 1.7, center: [2, 1] },
  { id: 'dev-user-0003', name: 'Aoi', color: '#b7ff7f', ax: 3.9, az: 1.8, fx: 0.13, fz: 0.31, phase: 3.1, center: [-2, 2] },
  { id: 'dev-user-0004', name: 'Ren', color: '#ff7fd0', ax: 2.1, az: 2.9, fx: 0.29, fz: 0.21, phase: 4.6, center: [1, 3] },
]

const makeMovement = (): PlayerMovement => ({
  position: { x: 0, y: 0, z: 0 },
  direction: { x: 0, z: 0 },
  horizontalSpeed: 0,
  verticalSpeed: 0,
  rotation: { yaw: 0, pitch: 0 },
  isGrounded: true,
  isJumping: false,
})

const store = new Map<string, PlayerMovement>()
for (const a of AGENTS) store.set(a.id, makeMovement())

/** t 秒時点の立ち位置。全員が時々中央に寄ってくるようにして集合ショットを試せるようにする */
const positionAt = (a: Agent, t: number, out: Vector3): void => {
  const gather = (Math.sin(t * 0.055) + 1) / 2 // 0..1 でゆっくり寄る／散る
  const spread = 0.35 + (1 - gather) * 0.65
  out.set(
    a.center[0] * spread + Math.sin(t * a.fx + a.phase) * a.ax * spread,
    0,
    a.center[1] * spread + Math.cos(t * a.fz + a.phase * 1.7) * a.az * spread,
  )
}

export const Crowd = () => {
  const groups = useRef<(Group | null)[]>([])
  const labels = useMemo(
    () =>
      AGENTS.map((a) =>
        makeLabelTexture(a.name, {
          width: 256,
          height: 64,
          color: a.color,
          background: 'rgba(0,0,0,0.55)',
          fontSize: 34,
        }),
      ),
    [],
  )

  const work = useMemo(() => ({ p: new Vector3(), q: new Vector3() }), [])

  useFrame((state) => {
    const t = state.clock.elapsedTime
    for (let i = 0; i < AGENTS.length; i++) {
      const a = AGENTS[i]
      positionAt(a, t, work.p)
      positionAt(a, t + 0.1, work.q)
      const vx = (work.q.x - work.p.x) / 0.1
      const vz = (work.q.z - work.p.z) / 0.1
      const speed = Math.hypot(vx, vz)
      // Three の流儀で前方は -Z
      const yaw = Math.atan2(-vx, -vz)

      const m = store.get(a.id)!
      m.position.x = work.p.x
      m.position.y = 0
      m.position.z = work.p.z
      m.direction.x = speed > 1e-4 ? vx / speed : 0
      m.direction.z = speed > 1e-4 ? vz / speed : 0
      m.horizontalSpeed = speed
      m.rotation.yaw = yaw

      const g = groups.current[i]
      if (g) {
        g.position.set(work.p.x, 0, work.p.z)
        g.rotation.y = yaw
      }
    }
  })

  return (
    <>
      {AGENTS.map((a, i) => (
        <group
          key={a.id}
          ref={(el) => {
            groups.current[i] = el
          }}
        >
          <mesh position={[0, 0.55, 0]} castShadow>
            <capsuleGeometry args={[0.22, 0.6, 6, 12]} />
            <meshStandardMaterial color={a.color} roughness={0.6} />
          </mesh>
          <mesh position={[0, 1.24, 0]} castShadow>
            <sphereGeometry args={[0.19, 16, 12]} />
            <meshStandardMaterial color="#f3d9c4" roughness={0.75} />
          </mesh>
          {/* 顔の向きが分かるように鼻をつける */}
          <mesh position={[0, 1.24, -0.19]}>
            <boxGeometry args={[0.06, 0.06, 0.06]} />
            <meshStandardMaterial color="#333" />
          </mesh>
          <BillboardY position={[0, 1.72, 0]}>
            <mesh>
              <planeGeometry args={[0.7, 0.175]} />
              <meshBasicMaterial map={labels[i]} transparent toneMapped={false} />
            </mesh>
          </BillboardY>
        </group>
      ))}
    </>
  )
}

/**
 * 開発用のブリッジ。タブが非表示だと rAF が止まって検証できないので、
 * 外から手動でフレームを進められるようにしておく。dev.tsx なので本番には出ない。
 */
export const DevBridge = () => {
  const state = useThree()
  useEffect(() => {
    const w = window as unknown as { __dev?: unknown }
    w.__dev = {
      state,
      resize: (width: number, height: number) => {
        state.gl.setSize(width, height, false)
        state.setSize(width, height)
      },
      step: (frames = 1, dt = 1 / 60) => {
        for (let i = 0; i < frames; i++) state.advance(performance.now() / 1000 + i * dt)
      },
      shot: async (name = 'shot') => {
        const dataUrl = state.gl.domElement.toDataURL('image/png')
        const res = await fetch('/__shot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, dataUrl }),
        })
        return res.json()
      },
    }
    return () => {
      delete (window as unknown as { __dev?: unknown }).__dev
    }
  }, [state])
  return null
}

export const Scene = () => {
  const usersImplementation = useMemo<UsersContextValue>(() => {
    const toUser = (a: Agent): User => ({
      id: a.id,
      displayName: a.name,
      avatarUrl: null,
      isGuest: false,
    })
    const height = { height: 1.62, eyeHeight: 1.5 }
    return {
      localUser: toUser(AGENTS[0]),
      remoteUsers: AGENTS.slice(1).map(toUser),
      getMovement: (id) => store.get(id),
      getLocalMovement: () => store.get(AGENTS[0].id)!,
      getAvatarHeight: () => height,
      getLocalAvatarHeight: () => height,
    }
  }, [])

  return (
    <XRiftProvider baseUrl="/" usersImplementation={usersImplementation}>
      <Physics>
        <color attach="background" args={['#0d1218']} />
        <fog attach="fog" args={['#0d1218', 22, 60]} />
        <ambientLight intensity={0.55} />
        <hemisphereLight args={['#bcd7ff', '#3a3428', 0.5]} />
        <directionalLight position={[6, 9, 4]} intensity={1.5} castShadow />

        <Crowd />
        <Item position={[0, 0, -4]} />

        <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[60, 60]} />
          <meshStandardMaterial color="#6f7480" />
        </mesh>
        <Grid
          args={[60, 60]}
          cellSize={1}
          cellColor="#8a90a0"
          sectionSize={5}
          sectionColor="#aab2c4"
          fadeDistance={45}
          position={[0, 0.002, 0]}
        />
        {/* 壁がわりの柱。ショットの奥行きを見るため */}
        {[-8, 8].map((x) =>
          [-8, 8].map((z) => (
            <mesh key={`${x}:${z}`} position={[x, 1.5, z]} castShadow>
              <boxGeometry args={[0.6, 3, 0.6]} />
              <meshStandardMaterial color="#4a5162" />
            </mesh>
          )),
        )}
      </Physics>
    </XRiftProvider>
  )
}

