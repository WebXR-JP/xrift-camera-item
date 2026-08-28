/**
 * 検証用の headless エントリ（/dev-headless.html）。本番ビルドには含まれない。
 *
 * <Canvas> は ResizeObserver でコンテナを測ってから WebGL を初期化するが、
 * タブが非表示だと ResizeObserver が配送されず、いつまでも起動しない。
 * ここでは R3F の命令型 API でサイズを直接与えて起動し、frameloop を
 * 'demand' にして外から 1 フレームずつ進められるようにしている。
 */

import * as THREE from 'three'
import { createRoot, events, extend } from '@react-three/fiber'
import { DevBridge, Scene } from './devScene'

// <Canvas> が内部でやっているカタログ登録を、命令型 API では自分でやる
extend(THREE as unknown as Parameters<typeof extend>[0])

// 検証スクリプトから three のクラスを触れるようにしておく
;(window as unknown as { __three?: unknown }).__three = THREE

const canvas = document.getElementById('gl') as HTMLCanvasElement | null
if (!canvas) throw new Error('canvas #gl not found')

const width = Number(new URLSearchParams(location.search).get('w') ?? 1280)
const height = Number(new URLSearchParams(location.search).get('h') ?? 720)
canvas.width = width
canvas.height = height

const root = createRoot(canvas)
void root
  .configure({
    events,
    size: { width, height, top: 0, left: 0 },
    dpr: 1,
    shadows: true,
    frameloop: 'demand',
    gl: { preserveDrawingBuffer: true, antialias: true },
    camera: { position: [7, 4.5, 7], fov: 50 },
  })
  .then((r) => {
    r.render(
      <>
        <DevBridge />
        <Scene />
      </>,
    )
  })
