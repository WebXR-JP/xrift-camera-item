import { useEffect, useMemo, useRef, useState } from 'react'
import { useInstanceState, useUsers } from '@xrift/world-components'
import { CAMERA_MODES, type CameraMode, type DirectorState, type Subject } from './types'
import { DIRECTOR, MOTION } from './constants'
import { mulberry32, pickWeighted, lerp } from './math'
import { SHOTS, SHOT_BY_ID, moverOf, type ShotDef } from './shots'
import type { SubjectTracker } from './useSubjects'

const INITIAL: DirectorState = {
  shot: 'wide',
  ids: [],
  startedAt: 0,
  duration: 6000,
  seed: 1,
  mode: 'auto',
  pinned: '',
  rev: 0,
}

/**
 * モードごとに使うショット。
 * 「誰を撮るか」がモードの意味なので、寄り引きの都合で主役以外に画が寄る
 * ショットは候補から外す。載っていないモードは全ショットから選ぶ。
 */
const MODE_SHOTS: Partial<Record<CameraMode, string[]>> = {
  follow: ['closeup', 'chase', 'orbit', 'low', 'ots'],
  pin: ['closeup', 'chase', 'orbit', 'low', 'ots'],
  action: ['chase', 'orbit', 'low'],
}

/** 主役が変わったら切り直すモード。誰を撮るかが変わったのに画が変わらないと間延びする */
const PINS_SUBJECT: CameraMode[] = ['auto', 'action', 'pin']

/** seed から決定論的な乱数列を作る。ショットのポーズ計算に使う */
const expandSeed = (seed: number): number[] => {
  const rand = mulberry32(seed)
  const out: number[] = []
  for (let i = 0; i < 8; i++) out.push(rand())
  return out
}

export interface Director {
  /** 現在のショット定義。park のときは null */
  shot: ShotDef | null
  label: string
  /** useFrame から読む現在モード（フレーム精度） */
  mode: CameraMode
  /** レンダー時に読む現在モード。ボタンのハイライトはこちらを見る */
  uiMode: CameraMode
  /** PIN で指名されている人。未指名なら null（useFrame 用） */
  pinnedId: string | null
  /** 同上、レンダー用 */
  uiPinnedId: string | null
  /** MODE ボタンを押したときに切り替わる先。ボタンの表示に使う */
  nextMode: CameraMode
  /** このクライアントがカットを決める役かどうか */
  isDirector: boolean
  /** フレームに入れる被写体（先頭が主役） */
  cast: Subject[]
  primary: Subject | null
  startedAt: number
  duration: number
  seed: number
  rnd: number[]
  /** カットしてからの経過（ms） */
  elapsed: number
  /** 直近のカットからの経過が小さいほど 1 に近い。カット演出用 */
  cutFlash: number
  setMode(mode: CameraMode): void
  cycleMode(): void
  /** 指名を 1 人ずらす（+1 で次、-1 で前）。同時に PIN モードへ入る */
  focusStep(dir: number): void
  cut(): void
  update(nowMs: number, tracker: SubjectTracker): void
}

/**
 * 「いつ・誰を・どう撮るか」を決めるディレクター。
 *
 * カット割りだけを useInstanceState で同期し、カメラの軌道は各端末が
 * 同じシードから同じ式で計算する。毎フレーム座標を送らずに全員の画面で
 * 同じ絵になる（＝通信量はカット 1 回ぶんだけ）。
 *
 * 書き込むのは参加者 ID を並べて先頭の 1 人だけ。全員が書くと取り合いになる。
 */
export const useDirector = (stateKey: string, defaultMode: CameraMode): Director => {
  const users = useUsers()
  const [state, setState] = useInstanceState<DirectorState>(stateKey, {
    ...INITIAL,
    mode: defaultMode,
  })

  // モードと指名だけ React 側にもミラーを持つ。ボタンのハイライトはレンダーで
  // 描くので、useInstanceState の反映を待つと自分の操作が一拍遅れて見える。
  // 書いた瞬間にこちらも更新し、リモートからの変更は effect で追う。
  const [uiMode, setUiMode] = useState<CameraMode>(defaultMode)
  const [uiPinned, setUiPinned] = useState('')
  useEffect(() => {
    setUiMode(state.mode)
    setUiPinned(state.pinned ?? '')
  }, [state.mode, state.pinned])

  const setStateRef = useRef(setState)
  setStateRef.current = setState

  const stateRef = useRef<DirectorState>(state)
  useEffect(() => {
    if (state.rev >= stateRef.current.rev) stateRef.current = state
  }, [state])

  // 参加者 ID を並べた先頭がディレクター役。全員が同じ判定に落ち着く
  const localId = users.localUser?.id ?? null
  const isDirector = useMemo(() => {
    const ids = [localId, ...(users.remoteUsers ?? []).map((u) => u.id)].filter(
      (v): v is string => !!v,
    )
    if (ids.length === 0) return true
    ids.sort()
    return localId === null ? true : ids[0] === localId
  }, [localId, users.remoteUsers])

  const isDirectorRef = useRef(isDirector)
  isDirectorRef.current = isDirector

  const localIdRef = useRef(localId)
  localIdRef.current = localId

  const director = useMemo<Director>(() => {
    const cast: Subject[] = []
    /** 今いる人の ID を昇順で。全クライアントで同じ並びにするため */
    const roster: string[] = []
    let seedCache = -1
    let rndCache: number[] = expandSeed(1)
    let primary: Subject | null = null
    let stickyPrimaryId: string | null = null
    let stickyMoverId: string | null = null
    let lastWideAt = 0
    let subjectChangedAt = 0
    let lastCutAt = 0
    let firstUpdateAt = 0

    const apply = (next: DirectorState) => {
      stateRef.current = next
      setUiMode(next.mode)
      setUiPinned(next.pinned ?? '')
      setStateRef.current(next)
    }

    /** 注目度がいちばん高い人。ぱたぱた入れ替わると見づらいので少しだけ粘る */
    const pickAttention = (all: Subject[]): Subject | null => {
      if (all.length === 0) return null
      let best = all[0]
      for (const s of all) if (s.attention > best.attention) best = s
      const sticky = stickyPrimaryId
        ? all.find((s) => s.id === stickyPrimaryId)
        : undefined
      if (sticky && best !== sticky && best.attention < sticky.attention * 1.18) {
        return sticky
      }
      stickyPrimaryId = best.id
      return best
    }

    /** いちばん動いている人。差が小さいうちは今の人を続投させる */
    const pickMover = (all: Subject[]): Subject | null => {
      const best = moverOf(all)
      if (!best) return null
      const cur = stickyMoverId ? all.find((s) => s.id === stickyMoverId) : undefined
      if (
        cur &&
        cur !== best &&
        cur.motion > MOTION.IDLE &&
        best.motion < cur.motion * MOTION.SWITCH_RATIO
      ) {
        return cur
      }
      stickyMoverId = best.id
      return best
    }

    /**
     * そのモードで主役を誰にするか。
     * AUTO 以外は「誰を撮るか」がモードの意味そのものなので、ここで決め切る。
     * 該当者が居ないときだけ注目度による自動選択へ落ちる。
     */
    const pickPrimary = (mode: CameraMode, tracker: SubjectTracker): Subject | null => {
      const all = tracker.list
      const auto = pickAttention(all)
      const pinned = stateRef.current.pinned
      switch (mode) {
        case 'follow':
          return (localIdRef.current ? tracker.byId(localIdRef.current) : null) ?? auto
        case 'pin':
          return (pinned ? tracker.byId(pinned) : null) ?? auto
        case 'action':
          return pickMover(all) ?? auto
        default:
          return auto
      }
    }

    const chooseShot = (
      mode: CameraMode,
      all: Subject[],
      prim: Subject | null,
      nowMs: number,
      prevId: string,
    ): ShotDef | null => {
      if (mode === 'park') return null

      if (mode === 'orbit') return SHOT_BY_ID.get('orbit') ?? null

      const allow = MODE_SHOTS[mode]
      const sinceWide = nowMs - lastWideAt
      const weights = SHOTS.map((shot) => {
        if (all.length < shot.minCast) return 0
        if (DIRECTOR.AVOID_REPEAT && shot.id === prevId) return 0
        if (allow && !allow.includes(shot.id)) return 0
        if (shot.select(all, prim).length < shot.minCast) return 0
        return Math.max(0, shot.weight(all, prim, sinceWide))
      })

      const idx = pickWeighted(weights, Math.random())
      if (idx < 0) return SHOT_BY_ID.get('wide') ?? null
      return SHOTS[idx]
    }

    const performCut = (nowMs: number, tracker: SubjectTracker, mode: CameraMode) => {
      const all = tracker.list
      const prim = pickPrimary(mode, tracker)

      const shot = chooseShot(mode, all, prim, nowMs, stateRef.current.shot)
      if (!shot) {
        apply({
          ...stateRef.current,
          shot: 'park',
          ids: [],
          startedAt: nowMs,
          duration: 1e9,
          rev: stateRef.current.rev + 1,
        })
        return
      }

      let picked = shot.select(all, prim)
      // 主役を指定するモードでは、ショットの都合より指名を優先する
      if (prim && MODE_SHOTS[mode]) {
        picked = [prim, ...picked.filter((s) => s !== prim)]
      }
      if (picked.length === 0 && prim) picked = [prim]

      const seed = (Math.random() * 0xffffffff) >>> 0
      const rand = mulberry32(seed ^ 0x9e3779b9)
      const duration = lerp(shot.duration[0], shot.duration[1], rand()) * 1000

      if (shot.id === 'wide' || shot.id === 'topdown') lastWideAt = nowMs
      lastCutAt = nowMs

      apply({
        ...stateRef.current,
        shot: shot.id,
        ids: picked.map((s) => s.id),
        startedAt: nowMs,
        duration,
        seed,
        mode,
        rev: stateRef.current.rev + 1,
      })
    }

    const self: Director = {
      shot: null,
      label: 'WS',
      mode: defaultMode,
      uiMode: defaultMode,
      pinnedId: null,
      uiPinnedId: null,
      nextMode: 'action',
      isDirector: true,
      cast,
      primary: null,
      startedAt: 0,
      duration: 6000,
      seed: 1,
      rnd: rndCache,
      elapsed: 0,
      cutFlash: 0,

      setMode: (mode) => {
        const st = stateRef.current
        // PIN に入るときは、今映っている人をそのまま指名する
        const pinned =
          mode === 'pin' ? st.pinned || (primary ? primary.id : (roster[0] ?? '')) : st.pinned
        apply({
          ...st,
          mode,
          pinned,
          startedAt: 0, // 次の update で必ず切り直す
          rev: st.rev + 1,
        })
      },

      cycleMode: () => {
        const i = CAMERA_MODES.indexOf(stateRef.current.mode)
        self.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length])
      },

      focusStep: (dir) => {
        if (roster.length === 0) return
        const st = stateRef.current
        // 未指名なら「今映っている人の次」から始める
        const anchor = st.pinned || (primary ? primary.id : '')
        const i = roster.indexOf(anchor)
        const step = dir >= 0 ? 1 : -1
        const next =
          i < 0
            ? roster[step > 0 ? 0 : roster.length - 1]
            : roster[(i + step + roster.length) % roster.length]
        apply({ ...st, mode: 'pin', pinned: next, startedAt: 0, rev: st.rev + 1 })
      },

      cut: () => {
        apply({ ...stateRef.current, startedAt: 0, rev: stateRef.current.rev + 1 })
      },

      update: (nowMs, tracker) => {
        const st = stateRef.current
        self.mode = st.mode
        self.pinnedId = st.pinned || null
        self.isDirector = isDirectorRef.current
        self.nextMode =
          CAMERA_MODES[(CAMERA_MODES.indexOf(st.mode) + 1) % CAMERA_MODES.length]

        // seed が変わったときだけ乱数列を作り直す
        if (st.seed !== seedCache) {
          seedCache = st.seed
          rndCache = expandSeed(st.seed)
        }
        self.rnd = rndCache
        self.seed = st.seed

        roster.length = 0
        for (const s of tracker.list) roster.push(s.id)
        roster.sort()

        primary = pickPrimary(st.mode, tracker)
        self.primary = primary

        // ids からキャストを復元。抜けた人は落とす
        cast.length = 0
        for (const id of st.ids) {
          const s = tracker.byId(id)
          if (s && s.alive) cast.push(s)
        }

        self.shot = st.shot === 'park' ? null : (SHOT_BY_ID.get(st.shot) ?? null)
        self.label = st.mode === 'park' ? 'PARK' : (self.shot?.label ?? '--')
        self.startedAt = st.startedAt
        self.duration = st.duration
        self.elapsed = Math.max(0, nowMs - st.startedAt)
        self.cutFlash = Math.max(0, 1 - (nowMs - lastCutAt) / 320)

        // 撮られている人にはペナルティを溜める（同じ人ばかり映さないため）
        for (const s of cast) s.filmedMs += 16

        if (firstUpdateAt === 0) firstUpdateAt = nowMs

        if (!isDirectorRef.current) {
          // ディレクターが止まっている（タブが裏・離脱直後）なら引き継ぐ
          const since = st.startedAt > 0 ? st.startedAt + st.duration : firstUpdateAt
          if (nowMs - since < DIRECTOR.STALE_TAKEOVER_MS) return
        }

        // 指名した人が居なくなったら、居る人へ寄せ直す
        if (
          st.mode === 'pin' &&
          st.pinned &&
          !tracker.byId(st.pinned) &&
          roster.length > 0
        ) {
          apply({ ...st, pinned: roster[0], startedAt: 0, rev: st.rev + 1 })
          return
        }

        if (st.mode === 'park') {
          if (st.shot !== 'park') {
            apply({
              ...st,
              shot: 'park',
              ids: [],
              startedAt: nowMs,
              duration: 1e9,
              rev: st.rev + 1,
            })
          }
          return
        }

        const elapsed = nowMs - st.startedAt

        // 主役が入れ替わったら切り直す。ふらついただけで切らないよう、
        // 入れ替わった状態が少し続いてからにする
        const subjectChanged =
          PINS_SUBJECT.includes(st.mode) &&
          primary !== null &&
          cast.length > 0 &&
          cast[0].id !== primary.id
        if (!subjectChanged) subjectChangedAt = 0
        else if (subjectChangedAt === 0) subjectChangedAt = nowMs

        const needCut =
          st.startedAt === 0 ||
          st.shot === 'park' ||
          elapsed > st.duration ||
          (cast.length === 0 && tracker.list.length > 0) ||
          (subjectChanged &&
            nowMs - subjectChangedAt > DIRECTOR.SUBJECT_CUT_DELAY_MS &&
            elapsed > DIRECTOR.MIN_SHOT_MS)

        if (needCut) performCut(nowMs, tracker, st.mode)
      },
    }

    return self
  }, [defaultMode])

  // レンダー時点の値を載せ直す（ボタンのハイライトはこれを見る）
  director.uiMode = uiMode
  director.uiPinnedId = uiPinned || null

  return director
}
