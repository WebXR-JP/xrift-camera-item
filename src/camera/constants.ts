/**
 * 画質プリセット。既定は軽さ優先の 'normal'。
 *
 * ここで決まる解像度は「モニタに映る絵」と「録画される .webm」の両方の解像度。
 * 上げるとオフスクリーンパスのピクセル数がそのまま増えるので、録画をきれいに
 * 残したいワールドだけ上げる想定にしてある。
 */
export const FEED_QUALITY = {
  /** 遠景の飾りとして置くとき */
  low: { width: 256, height: 144, fps: 15 },
  /** 既定。1.5m のモニタを 2m ほど離れて見るぶんには足りる */
  normal: { width: 384, height: 216, fps: 20 },
  /** 録画を残したいとき */
  high: { width: 640, height: 360, fps: 24 },
  /** 素材として使いたいとき。重い */
  ultra: { width: 960, height: 540, fps: 30 },
} as const

export type FeedQuality = keyof typeof FEED_QUALITY

/** モニタ映像（POV パス）の負荷まわり */
export const FEED = {
  /**
   * cullDistance いっぱいまで離れたときの POV パスの fps。
   * 遠くのモニタは数ピクセルにしかならないので、ここまで落としても分からない。
   */
  FAR_FPS: 6,
  /** 同じく、ビューファインダ HUD の再描画 fps（近く / 遠く） */
  HUD_FPS: 12,
  HUD_FAR_FPS: 4,
  /**
   * 4 分割マルチビューの更新 fps。各チャンネルは監視用なのでメインより落とす。
   * 1 パスで 4 分の 1 の面積を 4 回描くため、ここを上げると他が犠牲になる
   */
  MULTIVIEW_FPS: 10,
  /** 視界判定に使うモニタの外接球の半径（m）。操作 UI のぶんまで含める */
  MONITOR_RADIUS: 1.6,
} as const

/** 「よく動いている人」の判定パラメータ */
export const MOTION = {
  /** この速さ（m/s）で motion が 1 になる。歩き 1.5・走り 4 くらい */
  FULL_SPEED: 3.2,
  /** ジャンプ中の加点 */
  JUMP_BONUS: 0.45,
  /** 立ち上がり / 立ち下がりの時定数（秒）。落ちるのを遅くして主役の点滅を防ぐ */
  ATTACK: 0.25,
  RELEASE: 1.8,
  /** これ未満は「止まっている」扱い */
  IDLE: 0.06,
  /** ACTION モードで主役を入れ替えるのに必要な差（倍率） */
  SWITCH_RATIO: 1.35,
  /** 追走ショット（TRK）を選ぶ下限 */
  CHASE_MIN: 0.28,
} as const

/** 演出まわりの既定値 */
export const DIRECTOR = {
  /** 1 カットの最短時間（ms）。主役が変わってもこれ以下では切らない */
  MIN_SHOT_MS: 1900,
  /** 主役の交代を検出してからカットするまでの猶予（ms） */
  SUBJECT_CUT_DELAY_MS: 450,
  /** 同じショットを 2 連続で選ばない */
  AVOID_REPEAT: true,
  /**
   * ディレクター役が沈黙してからこの時間が過ぎたら、他のクライアントが引き継ぐ。
   * タブが裏に回ると rAF が止まってカットが進まなくなるので、これが無いと
   * 全員の画面でカメラが固まる。
   */
  STALE_TAKEOVER_MS: 3200,
} as const

/** ドローンの飛行特性 */
export const RIG = {
  /** 位置の追従の速さ */
  POS_LAMBDA: 1.9,
  /** 注視点の追従の速さ */
  LOOK_LAMBDA: 4.5,
  /** 画角の追従の速さ */
  FOV_LAMBDA: 2.5,
  /** 最大速度（m/s）。これを超えないよう desired への追従を制限する */
  MAX_SPEED: 7.5,
  /** バンク角の最大値（ラジアン） */
  MAX_BANK: 0.42,
  /** ローターの最大回転速度（rad/s） */
  MAX_ROTOR: 140,
  /** 被写体にこれ以上近づかない（m） */
  MIN_SUBJECT_DISTANCE: 0.9,
} as const
