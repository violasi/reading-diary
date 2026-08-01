/** .rdpkg 任务包格式，与 .claude/skills/reading-pack 产出的 manifest 对应 */

export interface PackPage {
  image: string
  audio: string | null
  /** 仅在没有真人音频、需要 TTS 时才有 */
  text?: string
}

export interface PackPiece {
  id: string
  title: string
  lang: string
  listen: { mode?: 'sequence'; audio?: string | null }
  pages: PackPage[]
  cover?: string
  level?: string
  source?: string
}

export interface PackManifest {
  format: 'reading-diary-pack'
  version: number
  date: string
  child?: string
  note?: string
  pieces: PackPiece[]
}

/** 一天的进度。key 是 piece.id */
export interface PieceProgress {
  /** 第一关：完整听过一遍（有音频的书） */
  listened: boolean
  /** 第二关：已跟读完的页数 */
  pagesRead: number
  /** 第三关 / 第二步：已录音并交给家长 */
  recorded: boolean
  /** 无音频的书：自由浏览过一遍 */
  browsed: boolean
}

/**
 * 两种书两条流程：
 *   listen —— 有真人音或有 text（能 TTS）：听一遍 → 跟读 → 录音（三关）
 *   browse —— 纯图的亲子阅读绘本：自由浏览 → 录音（可选）（两步）
 *
 * 从内容里推导而不是读 manifest 字段，这样老任务包也能正确处理。
 */
export type PieceMode = 'listen' | 'browse'

export const modeOf = (piece: PackPiece): PieceMode =>
  piece.pages.some((p) => p.audio || p.text) ? 'listen' : 'browse'

export type DayProgress = Record<string, PieceProgress>

/** 当天陪读的奥特曼，首次进入时锁定 */
export interface DayCompanion {
  heroId: string
  lockedAt: number
}

export interface Settings {
  pin: string
  childName: string
}

export const emptyProgress = (): PieceProgress => ({
  listened: false,
  pagesRead: 0,
  recorded: false,
  browsed: false,
})

/** 关卡序号。listen 的书有 1~3，browse 的书只有 1~2 */
export type Stage = 1 | 2 | 3

export function stageOf(p: PieceProgress, piece: PackPiece): Stage {
  if (modeOf(piece) === 'browse') return p.browsed ? 2 : 1
  if (!p.listened) return 1
  if (p.pagesRead < piece.pages.length) return 2
  return 3
}

/** 一共几关。首页的进度点要按这个画 */
export const stageCount = (piece: PackPiece) => (modeOf(piece) === 'browse' ? 2 : 3)

/**
 * 这本读完了没。
 * browse 的书录音是可选的，浏览完就算读完 —— 亲子阅读本来就是大人念、
 * 孩子听，不该拿录音当门槛卡着不给盖章。
 */
export function isPieceDone(p: PieceProgress, piece: PackPiece): boolean {
  return modeOf(piece) === 'browse' ? p.browsed : p.recorded
}
