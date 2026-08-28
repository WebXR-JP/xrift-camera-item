import type { Vector3 } from 'three'

/** ディレクターの動作モード */
export type CameraMode =
  | 'auto'
  | 'action'
  | 'pin'
  | 'follow'
  | 'orbit'
  | 'park'

/** MODE ボタンで回る順番。UI のボタン並びもこの順 */
export const CAMERA_MODES: CameraMode[] = [
  'auto',
  'action',
  'pin',
  'follow',
  'orbit',
  'park',
]

export const MODE_LABEL: Record<CameraMode, string> = {
  auto: 'AUTO',
  action: 'ACTION',
  pin: 'PIN',
  follow: 'FOLLOW ME',
  orbit: 'ORBIT',
  park: 'PARK',
}

/** ボタンに載せる短い名前（FOLLOW ME は 2 段目に入らないので詰める） */
export const MODE_SHORT: Record<CameraMode, string> = {
  auto: 'AUTO',
  action: 'ACTION',
  pin: 'PIN',
  follow: 'FOLLOW',
  orbit: 'ORBIT',
  park: 'PARK',
}

/** ボタンの 2 行目。「押すと誰が映るか」だけを書く */
export const MODE_HINT: Record<CameraMode, string> = {
  auto: 'おまかせ',
  action: 'よく動く人',
  pin: '今の人に固定',
  follow: '自分',
  orbit: '回り込み',
  park: '停止',
}

/** ステータス表示用の説明文（ボタンより長く書ける） */
export const MODE_DESC: Record<CameraMode, string> = {
  auto: '動きと視線を見て自動で選ぶ',
  action: 'よく動いている人を追いかける',
  pin: '指名した人だけを撮り続ける',
  follow: '自分だけを撮り続ける',
  orbit: '全員のまわりを回り続ける',
  park: '台座に戻って止まる',
}

/** 追跡対象の 1 人分のスナップショット。毎フレーム同じオブジェクトを使い回す */
export interface Subject {
  id: string
  name: string
  isLocal: boolean
  /** 足元のワールド座標 */
  pos: Vector3
  /** 胸のあたり（フレーミングの基準点） */
  chest: Vector3
  /** 目線の高さ */
  head: Vector3
  /** アバターの身長（m） */
  height: number
  /** 体の向き（ラジアン、Three の Y 回転） */
  yaw: number
  /** 水平方向の速さ（m/s） */
  speed: number
  isJumping: boolean
  /**
   * ならした運動量 0..1。速度とジャンプを時定数付きで平滑化したもの。
   * 生の speed は 1 フレーム止まっただけで 0 に落ちるので、
   * 「よく動いている人」の判定にはこちらを使う。
   */
  motion: number
  /** 他ユーザーから見られている数 */
  lookedAtBy: number
  /** 直近に撮られた累積時間（ms）。多様性のためのペナルティ */
  filmedMs: number
  /** 総合注目度スコア */
  attention: number
  /** このフレームで存在するか */
  alive: boolean
}

/** 1 カットぶんのカメラ姿勢 */
export interface ShotPose {
  pos: Vector3
  look: Vector3
  fov: number
  /** ロール（ラジアン）。ドローンのバンク表現に使う */
  roll: number
}

/** インスタンス全体で同期されるディレクターの状態 */
export interface DirectorState {
  /** 現在のショット ID */
  shot: string
  /** フレームに入れる被写体 ID（先頭が主役） */
  ids: string[]
  /** ショット開始時刻（サーバ時計 ms） */
  startedAt: number
  /** このショットの長さ（ms） */
  duration: number
  /** 決定論的な動きのためのシード */
  seed: number
  mode: CameraMode
  /** PIN モードで指名されているユーザー ID。空文字で未指名 */
  pinned: string
  /** 更新カウンタ（デバッグ用） */
  rev: number
}
