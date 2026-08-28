import { useItem, useServerClock, usePlacementState } from '@xrift/world-components'

/**
 * プラットフォームが注入する Context のうち、Provider の外で例外を投げるものを
 * 安全に読むためのラッパ。
 *
 * hook 自体は毎レンダー必ず呼ぶので呼び出し順は保たれる。throw を握り潰すだけ。
 * これがあると dev.tsx や Triplex のような素の環境でもアイテムがそのまま動く。
 */

/** 設置されたアイテム固有の ID。取れなければ null（＝インスタンス同期のキーを共有名にする） */
export const useSafeItemId = (): string | null => {
  try {
    return useItem().id
  } catch {
    return null
  }
}

export interface Clock {
  now: () => number
  synced: boolean
}

/** サーバ時計。無ければ端末時計にフォールバックする */
export const useSafeClock = (): Clock => {
  try {
    const clock = useServerClock({ require: 'motion' })
    return { now: clock.now, synced: clock.synced }
  } catch {
    return { now: () => Date.now(), synced: false }
  }
}

/** 'preview'（設置プレビュー中）か 'placed' か */
export const useSafePlacement = (): 'preview' | 'placed' => {
  try {
    return usePlacementState().mode
  } catch {
    return 'placed'
  }
}
