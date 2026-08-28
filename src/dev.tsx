/**
 * 開発環境用エントリーポイント（npm run dev）。本番ビルドには含まれない。
 */

import { createRoot } from 'react-dom/client'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { DevBridge, Scene } from './devScene'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

createRoot(rootElement).render(
  <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
    <Canvas
      shadows
      camera={{ position: [7, 4.5, 7], fov: 50 }}
      gl={{ preserveDrawingBuffer: true }}
    >
      <DevBridge />
      <Scene />
      <OrbitControls target={[0, 1, 0]} makeDefault />
    </Canvas>
    <div
      style={{
        position: 'absolute',
        left: 16,
        bottom: 16,
        padding: '10px 14px',
        borderRadius: 8,
        background: 'rgba(10,14,20,0.72)',
        color: '#dfe7f0',
        font: '12px/1.6 ui-monospace, Consolas, monospace',
        pointerEvents: 'none',
        maxWidth: 460,
      }}
    >
      台座のボタンをクリック: <b>MODE</b> 撮影モード切替 / <b>CUT</b> 次のカット /{' '}
      <b>REC</b> 録画開始・停止（停止で webm がダウンロードされる）
      <br />
      ダミー参加者 4 人が歩き回り、疑似発話が順に立ち上がります。
    </div>
  </div>,
)
