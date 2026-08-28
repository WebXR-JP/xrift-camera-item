import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { defineConfig, type Plugin } from 'vite'
import dts from 'vite-plugin-dts'
import federation from '@originjs/vite-plugin-federation'

/**
 * 開発時だけ有効な画面キャプチャ用エンドポイント（POST /__shot）。
 * dev.tsx から canvas.toDataURL() を投げると .dev-shots/ に PNG が落ちる。
 * ビルド成果物には一切含まれない（apply: 'serve'）。
 */
const devScreenshot = (): Plugin => ({
  name: 'xrift-dev-screenshot',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__shot', (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end('POST only')
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            name?: string
            dataUrl: string
          }
          const base64 = body.dataUrl.slice(body.dataUrl.indexOf(',') + 1)
          const dir = path.resolve(__dirname, '.dev-shots')
          fs.mkdirSync(dir, { recursive: true })
          const file = path.join(dir, (body.name || 'shot') + '.png')
          fs.writeFileSync(file, Buffer.from(base64, 'base64'))
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, file }))
        } catch (e) {
          res.statusCode = 500
          res.end(String(e))
        }
      })
    })
  },
})

export default defineConfig({
  plugins: [
    devScreenshot(),
    react(),
    dts({
      insertTypesEntry: true,
    }),
    federation({
      name: 'xrift_recording_camera',
      filename: 'remoteEntry.js',
      exposes: {
        './Item': './src/index.tsx',
      },
      // shared は必ずホストが提供する実体を使う。
      // requiredVersion に狭い範囲を書くと、ホストが更新された時点で
      // アイテム同梱の __federation_shared_*.js へフォールバックするが、
      // その共有チャンクは配信されないためアイテムごと読み込めなくなる。
      // strictVersion は生成される実行時コードから参照されないので効かない。
      shared: {
        react: {
          singleton: true,
          requiredVersion: '*',
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '*',
        },
        'react-dom/client': {
          singleton: true,
        },
        'react/jsx-runtime': {
          singleton: true,
        },
        three: {
          singleton: true,
          requiredVersion: '*',
        },
        'three/addons/loaders/DRACOLoader.js': {
          singleton: true,
          version: '0.0.0',
        },
        '@react-three/fiber': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/rapier': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/drei': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/uikit': {
          singleton: true,
          requiredVersion: '*',
        },
        '@pmndrs/uikit': {
          singleton: true,
          requiredVersion: '*',
        },
        '@xrift/world-components': {
          singleton: true,
          requiredVersion: '*',
        },
      },
    }),
  ],
  build: {
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
    assetsDir: '',
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
  define: {
    global: 'globalThis',
  },
})
