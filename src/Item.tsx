import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Frustum,
  Group,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Sphere,
  Vector3,
  type Camera,
} from 'three'

import { Drone, useDroneRefs } from './parts/Drone'
import { Monitor } from './parts/Monitor'
import { Dock } from './parts/Dock'
import { PanelAtlas, TextPanel } from './parts/canvasTexture'

import { Viewfinder, type HudModel, type HudSubject } from './camera/hud'
import { useSubjects } from './camera/useSubjects'
import { useDirector } from './camera/useDirector'
import { useDroneRig } from './camera/useDroneRig'
import { useCameraFeed } from './camera/useCameraFeed'
import { useMultiviewFeed, lensPoses } from './camera/multiview'
import { useRecorder } from './camera/useRecorder'
import { useSafeClock, useSafeItemId, useSafePlacement } from './camera/platform'
import { applySafety, correctFraming, parkPose, type ShotContext } from './camera/shots'
import {
  CAMERA_MODES,
  MODE_DESC,
  MODE_HINT,
  MODE_LABEL,
  MODE_SHORT,
  type CameraMode,
  type ShotPose,
} from './camera/types'
import { clamp, lerp } from './camera/math'
import { FEED, FEED_QUALITY, MOTION, type FeedQuality } from './camera/constants'

export interface ItemProps {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
  /** 初期モード。設置後はボタンで切り替えられる */
  mode?: CameraMode
  /** 設置位置からの最大水平飛行距離（m） */
  range?: number
  /** 床からの最低高度（m） */
  minAltitude?: number
  /** 設置位置からの最高高度（m） */
  maxAltitude?: number
  /** 手ブレの強さ 0（完全に滑らか）〜1（ハンドヘルド風） */
  handheld?: number
  /** 現場モニタを出すか */
  showMonitor?: boolean
  monitorWidth?: number
  /**
   * 画質プリセット。解像度と fps がまとめて決まる。
   * 既定は軽さ優先の `'normal'`（384x216 / 20fps）。録画をきれいに残したいなら
   * `'high'`（640x360）や `'ultra'`（960x540）にする。
   */
  quality?: FeedQuality
  /** 解像度をプリセットによらず直接決めたいとき。片方だけでも効く */
  feedWidth?: number
  feedHeight?: number
  /** ドローン視点の描画 fps。省略するとプリセットの値 */
  feedFps?: number
  /** 録画 fps。省略するとプリセットの値（映像の更新より速く録っても中身は増えない） */
  recordFps?: number
  /** この距離より遠いクライアントでは映像パスを止める（見えないので） */
  cullDistance?: number
  /** 機体とモニタの影。切るとワールドの影パスから完全に外れる */
  shadows?: boolean
}

/** 名前が長い人でもレイアウトを崩さない */
const trimName = (name: string): string =>
  name.length > 14 ? name.slice(0, 13) + '…' : name

/**
 * atlas のコマ割り。0 と 1 は状態で書き換わる、それ以外は 1 回書いたら変わらない。
 * chip から CAMERA_MODES.length 個ぶんがモードのチップ。
 */
const SLOT = { mode: 0, rec: 1, cut: 2, next: 3, prev: 4, view: 5, chip: 6 } as const

/**
 * 操作パネルに貼る文字の一式。
 *
 * 「押すと何が起きるか」をボタンの面に書いておきたいので、文字は 2D キャンバス。
 * ただしラベルごとにテクスチャを作るとボタン 12 個で 12 マテリアルになるので、
 * 1 枚の atlas に詰めて uv で切り出す（＝全ボタンのラベルが 1 マテリアル・1 メッシュ）。
 * 声量メーターのように頻繁に変わるものだけ、別キャンバスの TextPanel に置く。
 */
const makePanelTextures = () => {
  const atlas = new PanelAtlas()
  atlas.set(SLOT.cut, 'CUT', 'カットを変える')
  atlas.set(SLOT.next, 'NEXT ▶', '次の人')
  atlas.set(SLOT.prev, '◀ PREV', '前の人')
  atlas.set(SLOT.view, '4-SPLIT', '全カメラを見る')
  CAMERA_MODES.forEach((m, i) => atlas.set(SLOT.chip + i, MODE_SHORT[m], MODE_HINT[m]))
  return {
    atlas,
    /** ラベルは全部この 1 枚から切り出すので、マテリアルも 1 つで足りる */
    labelMaterial: new MeshBasicMaterial({
      map: atlas.texture,
      transparent: true,
      toneMapped: false,
    }),
    /** モニタ下の「今フォーカスしている人」表示 */
    focusPanel: new TextPanel(768, 96),
    /** カットの切り替わり方の帯（瞬時 / 移動） */
    transitionPanel: new TextPanel(768, 96),
    /** 台座のステータス表示 */
    status: new TextPanel(640, 128),
  }
}

type PanelTextures = ReturnType<typeof makePanelTextures>

const disposePanelTextures = (ui: PanelTextures): void => {
  ui.atlas.dispose()
  ui.labelMaterial.dispose()
  ui.focusPanel.dispose()
  ui.transitionPanel.dispose()
  ui.status.dispose()
}

/** 台座からのモニタの高さ（m）。支柱は無く、ここに浮いている */
const MONITOR_Y = 1.55

const projScreen = new Matrix4()
const viewFrustum = new Frustum()
const monitorSphere = new Sphere(new Vector3(), FEED.MONITOR_RADIUS)

/**
 * モニタが画面に入っているか。
 *
 * 入っていなければ POV パスは丸ごと省ける。このアイテムでいちばん重いのは
 * 「ワールドをもう 1 回描く」ことなので、後ろを向いている間それを止められるのは大きい。
 * VR 中はここで使うカメラ行列が実際の描画と別物なので、距離だけで判断する。
 */
const monitorOnScreen = (camera: Camera, monitor: Group | null): boolean => {
  if (!monitor) return false
  monitor.getWorldPosition(monitorSphere.center)
  projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  viewFrustum.setFromProjectionMatrix(projScreen)
  return viewFrustum.intersectsSphere(monitorSphere)
}

const originVec = new Vector3()
const parentQuat = new Quaternion()
const localQuat = new Quaternion()
const tmpVec = new Vector3()
const viewVec = new Vector3()

/**
 * 自律飛行する撮影ドローン。
 *
 * やっていること:
 *  1. その場にいる全員を被写体として追跡する（位置・向き・移動・ジャンプ・視線）
 *  2. 動きと「何人に見られているか」から注目度を出して主役を決める
 *  3. ショットのカタログから状況に合うカットを選び、ドローンを飛ばして構図を作る
 *  4. ドローン視点をオフスクリーンに描いて、現場モニタに映す
 *  5. 押せばそのまま .webm として端末に保存する（映像のみ）
 *
 * カット割りだけをインスタンス同期し、軌道は各端末が同じ式で計算するので、
 * 全員の画面でドローンは同じところを飛ぶ。座標は 1 バイトも流していない。
 */
export const Item = ({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  mode = 'auto',
  range = 22,
  minAltitude = 0.45,
  maxAltitude = 14,
  handheld = 0.55,
  showMonitor = true,
  monitorWidth = 1.5,
  quality = 'normal',
  feedWidth,
  feedHeight,
  feedFps,
  recordFps,
  cullDistance = 32,
  shadows = true,
}: ItemProps) => {
  const { scene, gl } = useThree()

  // プリセットを基準に、個別指定があればそちらを優先する
  const preset = FEED_QUALITY[quality] ?? FEED_QUALITY.normal
  const feedW = feedWidth ?? preset.width
  const feedH = feedHeight ?? preset.height
  const feedRate = feedFps ?? preset.fps

  const rootRef = useRef<Group>(null)
  const monitorRef = useRef<Group>(null)
  const dockRef = useRef<Group>(null)
  const ringMat = useRef<MeshStandardMaterial | null>(null)
  const droneRefs = useDroneRefs()

  const itemId = useSafeItemId()
  const clock = useSafeClock()
  const placement = useSafePlacement()

  const tracker = useSubjects()
  const rig = useDroneRig()
  const director = useDirector(`recording-camera:${itemId ?? 'shared'}`, mode)
  const feed = useCameraFeed(feedW, feedH, feedRate)
  const multiview = useMultiviewFeed(feedW, feedH, FEED.MULTIVIEW_FPS)
  const recorder = useRecorder(recordFps ?? preset.fps)

  // 4 分割表示は閲覧者ごとの切り替え（同期しない）。同期すると他人の画面まで
  // 分割されてしまい、単に自分の絵を見たかった人まで影響する
  const [splitView, setSplitView] = useState(false)

  const viewfinder = useMemo(
    () => new Viewfinder(feedW, feedH),
    [feedW, feedH],
  )
  const ui = useMemo(makePanelTextures, [])

  useEffect(
    () => () => {
      viewfinder.dispose()
      disposePanelTextures(ui)
    },
    [viewfinder, ui],
  )

  // 毎フレーム使い回す作業用オブジェクト
  const work = useMemo(
    () => ({
      desired: {
        pos: new Vector3(),
        look: new Vector3(),
        fov: 45,
        roll: 0,
      } as ShotPose,
      /** マルチビューの各チャンネル（CAM2〜4）の理想姿勢 */
      channelPoses: [
        { pos: new Vector3(), look: new Vector3(), fov: 45, roll: 0 },
        { pos: new Vector3(), look: new Vector3(), fov: 45, roll: 0 },
        { pos: new Vector3(), look: new Vector3(), fov: 45, roll: 0 },
      ] as ShotPose[],
      ctx: {
        t: 0,
        progress: 0,
        rnd: [],
        cast: [],
        all: [],
        center: new Vector3(),
        radius: 1,
        aspect: feedW / feedH,
        origin: new Vector3(),
        floorY: 0,
        range,
        minAltitude,
        maxAltitude,
        facing: tracker.facing,
      } as ShotContext,
      hud: {
        nowMs: 0,
        mode: 'AUTO',
        shotLabel: 'WS',
        split: false,
        recording: false,
        recElapsedMs: 0,
        recSupported: true,
        fov: 45,
        speed: 0,
        altitude: 0,
        primaryMotion: 0,
        trackedCount: 0,
        cutFlash: 0,
        isDirector: true,
        clockSynced: false,
        subjects: [] as HudSubject[],
        primaryName: '',
        primaryPinned: false,
      } as HudModel,
      hidden: [] as Group[],
      first: true,
    }),
    [feedW, feedH, range, minAltitude, maxAltitude, tracker.facing],
  )

  const isPreview = placement === 'preview'
  const idPrefix = `recording-camera-${itemId ?? 'shared'}`
  /** 前フレームで見たディレクター状態の rev。変化したらカット（瞬時切替ならスナップ） */
  const lastRevRef = useRef(-1)
  // ボタンの位置は動かないので、切り出し範囲は 1 回だけ作って使い回す
  const atlasSlots = useMemo(
    () => ({
      dock: [SLOT.rec, SLOT.mode, SLOT.cut, SLOT.next].map((i) => ui.atlas.slot(i)),
      monitor: {
        chips: CAMERA_MODES.map((_, i) => ui.atlas.slot(SLOT.chip + i)),
        prev: ui.atlas.slot(SLOT.prev),
        next: ui.atlas.slot(SLOT.next),
        view: ui.atlas.slot(SLOT.view),
      },
    }),
    [ui],
  )

  useFrame((state, delta) => {
    const root = rootRef.current
    if (!root) return

    const now = clock.now()
    const dt = clamp(delta, 1 / 240, 0.1)
    const tSec = now / 1000

    root.getWorldPosition(originVec)

    // --- 被写体と声 ----------------------------------------------------
    if (!isPreview) {
      tracker.update(dt)
      director.update(now, tracker)
    }

    // --- 望ましいカメラ姿勢 --------------------------------------------
    const ctx = work.ctx
    ctx.all = tracker.list
    ctx.cast = director.cast.length > 0 ? director.cast : tracker.list
    ctx.rnd = director.rnd
    ctx.origin.copy(originVec)
    ctx.range = range
    ctx.minAltitude = minAltitude
    ctx.maxAltitude = maxAltitude
    ctx.aspect = feed.width / feed.height
    ctx.t = director.elapsed / 1000
    ctx.progress = clamp(director.elapsed / Math.max(1, director.duration), 0, 1)

    let floorY = originVec.y
    for (const s of ctx.all) floorY = Math.min(floorY, s.pos.y)
    ctx.floorY = floorY

    if (ctx.cast.length > 0) {
      ctx.center.set(0, 0, 0)
      for (const s of ctx.cast) ctx.center.add(s.chest)
      ctx.center.multiplyScalar(1 / ctx.cast.length)
      let r = 0
      for (const s of ctx.cast) {
        tmpVec.subVectors(s.chest, ctx.center)
        r = Math.max(r, tmpVec.length() + s.height * 0.45)
      }
      ctx.radius = Math.max(0.75, r)
    } else {
      ctx.center.copy(originVec)
      ctx.center.y += 1.2
      ctx.radius = 1
    }

    const shot = isPreview ? null : director.shot
    if (shot && ctx.cast.length >= shot.minCast) {
      shot.pose(ctx, work.desired)
    } else {
      parkPose(ctx, work.desired)
    }
    applySafety(ctx, work.desired)
    if (shot?.frameAll) correctFraming(ctx, work.desired)

    // --- ドローンを飛ばす ------------------------------------------------
    // 瞬時切替（cut）モードでは、カットの瞬間にカメラだけが理想姿勢へ一瞬で送られる
    // （機体は飛んで移動を続ける。絵が入れ替わるだけ）。
    // カット情報（rev）は useInstanceState で全員に同期されるので、
    // rev 変化を検知した全クライアントが同じフレームで一斉にスナップする
    const revChanged = !isPreview && director.rev !== lastRevRef.current
    if (revChanged) lastRevRef.current = director.rev
    const hardCut = !isPreview && director.transition === 'cut' && revChanged
    rig.update(work.desired, dt, tSec, isPreview ? 0 : handheld, work.first || hardCut)
    work.first = false

    const droneRoot = droneRefs.root.current
    if (droneRoot) {
      // ドローンはワールド空間を飛ぶが、シーングラフ上はアイテムの子。
      // アイテム側の transform を打ち消してローカル座標に直す
      droneRoot.position.copy(rig.pos)
      root.worldToLocal(droneRoot.position)
      root.getWorldQuaternion(parentQuat)
      localQuat.copy(parentQuat).invert().multiply(rig.bodyQuat)
      droneRoot.quaternion.copy(localQuat)

      const gimbal = droneRefs.gimbal.current
      if (gimbal) gimbal.quaternion.copy(rig.gimbalQuat)

      const spin = rig.rotorAngle
      for (let i = 0; i < droneRefs.rotors.length; i++) {
        const r = droneRefs.rotors[i].current
        if (r) r.rotation.y = i % 2 === 0 ? spin : -spin
      }
      const blur = clamp(rig.speed / 3, 0, 1)
      if (droneRefs.disc.current) droneRefs.disc.current.visible = blur > 0.05
      if (droneRefs.discMat.current) {
        droneRefs.discMat.current.opacity = 0.06 + blur * 0.16
      }
      if (droneRefs.tallyMat.current) {
        const pulse = recorder.recording ? 0.6 + Math.sin(now / 180) * 0.5 : 0.12
        droneRefs.tallyMat.current.emissiveIntensity = Math.max(0, pulse) * 3
      }
    }
    if (ringMat.current) {
      ringMat.current.emissive.set(recorder.recording ? '#ff3b30' : '#2fe3c0')
      ringMat.current.emissiveIntensity = recorder.recording
        ? 1.2 + Math.sin(now / 200) * 0.6
        : 0.9
    }

    // --- 操作パネルの文字 -------------------------------------------------
    // 「今どうなっていて、押すとどうなるか」をボタンの面に出す
    const focused = director.primary
    const focusMotion = focused ? focused.motion : 0
    const focusMoving = focusMotion > MOTION.IDLE
    const focusPinned = !!focused && director.pinnedId === focused.id

    ui.atlas.set(
      SLOT.mode,
      'MODE',
      `${MODE_SHORT[director.mode]} → ${MODE_SHORT[director.nextMode]}`,
    )
    ui.atlas.set(
      SLOT.rec,
      recorder.recording ? '■ STOP' : '● REC',
      recorder.recording ? '録画を止める' : '録画する',
      recorder.recording
        ? '#ff9a9a'
        : recorder.supported
          ? '#e8eef6'
          : 'rgba(232,238,246,0.35)',
    )
    ui.focusPanel.set(
      focused ? trimName(focused.name) : 'NO SUBJECT',
      focused
        ? `${focusPinned ? 'PIN 固定中' : `${MODE_LABEL[director.mode]} で選択中`}` +
            ` · ${focusMoving ? '移動中' : '静止中'}`
        : 'まわりに人がいません',
      focusMoving ? '#ffc454' : '#7fe9ff',
      focusMotion,
    )
    ui.transitionPanel.set(
      director.uiTransition === 'cut' ? '● カット: 瞬時切替' : '● カット: 飛んで移動',
      director.uiTransition === 'cut'
        ? '切り替えは一瞬。機体は移動を続ける'
        : 'カットのたびに機体が飛んで移動する',
      director.uiTransition === 'cut' ? '#7fe9ff' : '#ffb24d',
    )

    if (isPreview) {
      ui.status.set('CINE DRONE', 'PLACE TO ACTIVATE', '#7fe9ff')
      return
    }

    // --- 撮影用カメラ ----------------------------------------------------
    const cam = feed.camera
    cam.position.copy(rig.pos)
    cam.quaternion.copy(rig.camQuat)
    if (Math.abs(cam.fov - rig.fov) > 0.01 || cam.aspect !== ctx.aspect) {
      cam.fov = rig.fov
      cam.aspect = ctx.aspect
      cam.updateProjectionMatrix()
    }
    cam.updateMatrixWorld(true)

    const distanceToViewer = state.camera.position.distanceTo(originVec)
    const far = clamp(distanceToViewer / cullDistance, 0, 1)

    // 遠いモニタは数ピクセルにしかならないので、POV パスと HUD の更新頻度を落とす。
    // 録画中は出力の品質がそのまま落ちるので、そこだけは指定どおりに回す
    feed.fps = recorder.recording ? feedRate : lerp(feedRate, FEED.FAR_FPS, far * far)
    const hudFps = recorder.recording
      ? FEED.HUD_FPS
      : lerp(FEED.HUD_FPS, FEED.HUD_FAR_FPS, far * far)

    // 画面に入っていないモニタのために、ワールドをもう 1 回描く必要はない
    const monitorVisible =
      showMonitor &&
      far < 1 &&
      (gl.xr.isPresenting || monitorOnScreen(state.camera, monitorRef.current))
    const needFeed = recorder.recording || monitorVisible
    const needMultiview = splitView && monitorVisible && !recorder.recording

    if (needFeed) {
      work.hidden.length = 0
      if (monitorRef.current) work.hidden.push(monitorRef.current)
      if (droneRoot) work.hidden.push(droneRoot)
      feed.render(gl, scene, work.hidden, now)
    }

    // --- 4 分割マルチビュー -------------------------------------------------
    // 機体に載っている別レンズ（望遠・広角・機腹俯瞰）を同じ位置から並べて描く。
    // CAM1 がメインのプログラム絵。機体は 1 台のまま
    if (needMultiview) {
      const lensMain = {
        pos: cam.position,
        quat: cam.quaternion,
      }
      lensPoses(lensMain, work.channelPoses)
      work.hidden.length = 0
      if (monitorRef.current) work.hidden.push(monitorRef.current)
      if (droneRoot) work.hidden.push(droneRoot)
      multiview.render(gl, scene, cam, work.channelPoses, work.hidden, now)
    }

    // --- HUD -------------------------------------------------------------
    const hud = work.hud
    hud.nowMs = now
    hud.mode = MODE_LABEL[director.mode] ?? 'AUTO'
    hud.shotLabel = director.label
    hud.split = splitView
    hud.recording = recorder.recording
    hud.recElapsedMs = recorder.elapsedMs
    hud.recSupported = recorder.supported
    hud.fov = rig.fov
    hud.speed = rig.speed
    hud.altitude = rig.pos.y - floorY
    hud.primaryMotion = focusMotion
    hud.trackedCount = tracker.list.length
    hud.cutFlash = director.cutFlash
    hud.isDirector = director.isDirector
    hud.clockSynced = clock.synced
    hud.primaryName = focused ? trimName(focused.name) : ''
    hud.primaryPinned = focusPinned

    // 被写体の投影は HUD にしか使わない。モニタが見えていないなら丸ごと省く
    if (needFeed) {
      hud.subjects.length = 0
      for (const s of tracker.list) {
        const entry = projectSubject(s, cam)
        if (entry) {
          entry.name = s.name
          entry.motion = s.motion
          entry.primary = director.primary === s
          entry.pinned = director.pinnedId === s.id
          hud.subjects.push(entry)
        }
      }
      viewfinder.paint(hud, hudFps)
    }

    // --- 台座のステータス -------------------------------------------------
    // モニタが無い置き方でも「何モードで・誰を撮っているか」がここだけで分かる
    ui.status.set(
      `${MODE_LABEL[director.mode]}${focused ? `  ▸ ${trimName(focused.name)}` : ''}`,
      `${MODE_DESC[director.mode]}${recorder.recording ? '  · ●REC' : ''}`,
      recorder.recording ? '#ff6b6b' : focusMoving ? '#ffc454' : '#7fe9ff',
      focused ? focusMotion : -1,
    )

    // --- 録画 -------------------------------------------------------------
    recorder.tick(gl, feed, viewfinder.canvas, now)
  })

  return (
    <group ref={rootRef} position={position} rotation={rotation} scale={scale}>
      <Dock
        idPrefix={idPrefix}
        groupRef={dockRef}
        statusTexture={ui.status.texture}
        labelMaterial={ui.labelMaterial}
        labelSlots={atlasSlots.dock}
        recSupported={recorder.supported}
        ringRef={ringMat}
        onRec={() => recorder.toggle(feed)}
      />

      <Drone refs={droneRefs} shadows={shadows} />

      {showMonitor && (
        <Monitor
          groupRef={monitorRef}
          feed={splitView ? multiview.texture : feed.target.texture}
          hud={viewfinder.texture}
          split={splitView}
          width={monitorWidth}
          height={(monitorWidth * feedH) / feedW}
          y={MONITOR_Y}
          shadows={shadows}
          controls={{
            idPrefix,
            mode: director.uiMode,
            transition: director.uiTransition,
            labelMaterial: ui.labelMaterial,
            slots: atlasSlots.monitor,
            focusTexture: ui.focusPanel.texture,
            transitionTexture: ui.transitionPanel.texture,
            onSelectMode: (m) => director.setMode(m),
            onFocusStep: (d) => director.focusStep(d),
            onToggleSplit: () => setSplitView((v) => !v),
            onToggleTransition: () =>
              director.setTransition(director.uiTransition === 'cut' ? 'fly' : 'cut'),
          }}
        />
      )}
    </group>
  )
}

/**
 * 被写体をビューファインダ座標（0..1）に落とす。
 * カメラの後ろに居る点を project すると値が反転するので、先にビュー空間で弾く。
 */
const projectSubject = (
  s: { head: Vector3; pos: Vector3; height: number },
  camera: PerspectiveCamera,
): HudSubject | null => {
  viewVec.copy(s.head).applyMatrix4(camera.matrixWorldInverse)
  if (viewVec.z > -0.15) return null

  tmpVec.copy(s.head)
  tmpVec.y += s.height * 0.14
  tmpVec.project(camera)
  const topY = (1 - tmpVec.y) / 2
  const cx = (tmpVec.x + 1) / 2

  tmpVec.copy(s.pos)
  tmpVec.project(camera)
  const bottomY = (1 - tmpVec.y) / 2

  const h = Math.abs(bottomY - topY)
  const cy = (topY + bottomY) / 2
  if (cx < -0.25 || cx > 1.25 || cy < -0.35 || cy > 1.35) return null

  return {
    name: '',
    cx,
    cy,
    w: Math.max(0.05, h * 0.42),
    h: Math.max(0.06, h),
    motion: 0,
    primary: false,
    pinned: false,
    visible: true,
  }
}

export default Item
