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

export interface Settings {
  pin: string
  childName: string
}

/**
 * 一天的进度。key 是 piece.id
 *
 * 完成有**两条路**，都算读完：孩子点「读完了」，或者交了录音（录音本身就是
 * 「我读给爸爸妈妈听」）。`finished` 是归一化之后的完成状态 —— 判断读完只看它，
 * 别在界面里自己拼 `finished || recorded`。
 *
 * 归一化发生在两处，改动时两处都要顾：
 *   · 提交录音：App.tsx 的 onSubmitRecording 一并写 finished
 *   · 读取：db.ts 的 loadProgress 对 recorded 无条件补 finished
 *     （老版本留下过 { recorded: true, finished: false }，光靠提交路径补不回来）
 */
export interface PieceProgress {
  /** 归一化后的完成状态。两条路都会把它置 true */
  finished: boolean
  /** 交过录音。录音是可选的，但**交了就算读完** */
  recorded: boolean

  // ---- 以下是关卡时代留下的字段。不再驱动任何界面，只为了让老记录
  // ---- 能推导出 finished（见 db.ts 的 loadProgress），别再往里写新逻辑
  /** @deprecated 关卡时代：完整听过一遍 */
  listened: boolean
  /** @deprecated 关卡时代：已跟读完的页数 */
  pagesRead: number
  /** @deprecated 关卡时代：纯图绘本浏览过一遍 */
  browsed: boolean
}

/**
 * 这本书有没有可播的东西（真人音或能 TTS 的 text）。
 *
 * 只决定「要不要给听的按钮」，不再决定流程 —— 有音频没音频都是自由阅读。
 */
export const canPlay = (piece: PackPiece) => piece.pages.some((p) => p.audio || p.text)

export type DayProgress = Record<string, PieceProgress>

export const emptyProgress = (): PieceProgress => ({
  finished: false,
  recorded: false,
  listened: false,
  pagesRead: 0,
  browsed: false,
})

/**
 * 读完 = finished。两条路（点「读完了」/ 交录音）都已在写入和读取时归一化到
 * 这个字段，所以这里只看它一个 —— 听没听过、听了几遍都不影响。
 */
export const isPieceDone = (p: PieceProgress) => p.finished
