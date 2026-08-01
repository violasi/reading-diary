/**
 * 本地存储。全部在 IndexedDB，没有任何后端。
 *
 * 键的约定：
 *   pack:<date>       解包后的任务包 { manifest, files }
 *   progress:<date>   当天各篇进度
 *   rec:<date>:<pid>  孩子交的录音 Blob
 *   stars:<date>      家长打的星
 *   done:<date>       当天全部篇目都读完了 —— 真正的「打卡章」
 *   settings          PIN、孩子名字
 *   schemaVersion     数据结构版本，升级时用来判断要不要迁移
 *   dates             有任务包的日期列表（升序），日历和图书馆都用
 */
import { get, set, del, keys } from 'idb-keyval'
import type { DayProgress, PackManifest, PackPiece, Settings } from '../types'
import { emptyProgress } from '../types'

export interface StoredPack {
  manifest: PackManifest
  /** 包内相对路径 → Blob */
  files: Record<string, Blob>
}

export const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * 数据结构版本。
 *
 * App 升级后孩子的记录必须原样读出来，既不能被覆盖也不能被误读。两道保障：
 *   1. loadProgress 读出来一律用 emptyProgress() 补齐字段 —— 以后给
 *      PieceProgress 加新字段，老记录自动拿到默认值，不用写迁移。
 *      （browsed 就是后加的，更早的记录里没有这个键。）
 *   2. 真要改键的形状（比如 rec: 换命名、progress 拆表）时，在 migrate()
 *      里加一步并把版本号 +1，别直接改读取逻辑。
 */
const SCHEMA_VERSION = 1

export async function migrate(): Promise<{ from: number; to: number; steps: string[] }> {
  const from = (await get<number>('schemaVersion')) ?? 0
  const steps: string[] = []
  if (from === SCHEMA_VERSION) return { from, to: SCHEMA_VERSION, steps }

  // from < 1：browsed 是后加的字段，但 loadProgress 会补默认值，不必改写数据。
  // 这一版只是把基线版本号落下来，供以后的迁移判断。
  if (from < 1) steps.push('v1 基线')

  await set('schemaVersion', SCHEMA_VERSION)
  return { from, to: SCHEMA_VERSION, steps }
}

// ---- 任务包 ----
export const savePack = async (pack: StoredPack) => {
  const date = pack.manifest.date
  await set(`pack:${date}`, pack)
  const all = new Set(await listPackDates())
  all.add(date)
  await set('dates', [...all].sort())
}

export const loadPack = (date: string) => get<StoredPack>(`pack:${date}`)

export const listPackDates = async () => (await get<string[]>('dates')) ?? []

export const deletePack = async (date: string) => {
  await del(`pack:${date}`)
  await set('dates', (await listPackDates()).filter((d) => d !== date))
}

// ---- 进度 ----
/** 读出来一律补齐字段，这样以后加新字段不会把老记录读成 undefined */
export const loadProgress = async (date: string): Promise<DayProgress> => {
  const raw = (await get<Record<string, Partial<DayProgress[string]>>>(`progress:${date}`)) ?? {}
  const out: DayProgress = {}
  for (const [id, p] of Object.entries(raw)) out[id] = { ...emptyProgress(), ...p }
  return out
}

export const saveProgress = (date: string, p: DayProgress) => set(`progress:${date}`, p)

// ---- 打卡章 ----
/**
 * 「读了哪几天」以这个为准：当天所有书都读完了才盖。光是点进来翻两下
 * 不算，否则连续天数虚高，章就不值钱了。
 */
export const markDayDone = (date: string) => set(`done:${date}`, true)

export const loadDoneDates = async () => {
  const out: string[] = []
  for (const k of await keys()) {
    if (typeof k === 'string' && k.startsWith('done:')) out.push(k.slice('done:'.length))
  }
  return out.sort()
}

// ---- 录音 ----
export const saveRecording = (date: string, pieceId: string, blob: Blob) =>
  set(`rec:${date}:${pieceId}`, blob)

export const loadRecording = (date: string, pieceId: string) =>
  get<Blob>(`rec:${date}:${pieceId}`)

// ---- 家长打星 ----
export const loadStars = async (date: string) =>
  (await get<Record<string, number>>(`stars:${date}`)) ?? {}

export const saveStars = (date: string, stars: Record<string, number>) =>
  set(`stars:${date}`, stars)

// ---- 清理 ----

/**
 * 清掉一天的打卡记录：进度、星星、录音、打卡章。
 * 任务包留着 —— 书本身是内容，孩子还要复习，删了得重新导。
 */
export const clearDay = async (date: string) => {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string')
  await Promise.all([
    del(`progress:${date}`),
    del(`stars:${date}`),
    del(`companion:${date}`), // 老版本留下的，顺手清
    del(`done:${date}`),
    ...ks.filter((k) => k.startsWith(`rec:${date}:`)).map((k) => del(k)),
  ])
}

/** 全部清零。同样只清记录、不动任务包 */
export const clearAllProgress = async () => {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string')
  const doomed = ks.filter(
    (k) =>
      k.startsWith('progress:') ||
      k.startsWith('stars:') ||
      k.startsWith('companion:') || // 老版本留下的
      k.startsWith('done:') ||
      k.startsWith('rec:'),
  )
  await Promise.all(doomed.map((k) => del(k)))
  return doomed.length
}

/**
 * 录音一共占了多少。不自动清理，所以家长需要一个「该不该清」的信号 ——
 * App 变慢时点开家长页就能看到现在堆了多少。
 */
export const recordingsFootprint = async () => {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string')
  let bytes = 0
  let count = 0
  for (const k of ks) {
    if (!k.startsWith('rec:')) continue
    const blob = await get<Blob>(k)
    if (!blob) continue
    bytes += blob.size
    count++
  }
  return { count, bytes }
}

/**
 * 清掉「已评过分的往日录音」。
 *
 * 录音的用处就是让家长听一遍打个分，孩子不会反复听自己的；留着只会
 * 一天一天堆。但今天的一律不动 —— 家长可能刚点了 4 星又想重听改成 5 星。
 */
export const cleanupGradedRecordings = async (today = todayStr()) => {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string')
  const starsCache: Record<string, Record<string, number>> = {}
  let freed = 0
  let count = 0

  for (const k of ks) {
    if (!k.startsWith('rec:')) continue
    const [, date, pieceId] = k.split(':')
    if (!date || date >= today) continue // 今天的留着
    starsCache[date] ??= await loadStars(date)
    if (!starsCache[date][pieceId]) continue // 还没评分，留着
    const blob = await get<Blob>(k)
    freed += blob?.size ?? 0
    await del(k)
    count++
  }
  return { count, freed }
}

export interface LibraryBook {
  /** 这本书最近一次出现在哪天的任务包里 */
  date: string
  piece: PackPiece
  cover?: Blob
}

/**
 * 图书馆：所有导入过的书，不管有没有交过录音。
 *
 * 按书名去重 —— 同一本书常常连着好几天都在任务包里（有的书要看很多天），
 * 书架上只该有一本；同名的以最新导入的那份为准。
 */
export const listLibrary = async (): Promise<LibraryBook[]> => {
  const byTitle = new Map<string, LibraryBook>()
  for (const date of await listPackDates()) {
    // listPackDates 是升序，所以后面的（更新的）会自然覆盖前面的同名书
    const pack = await loadPack(date)
    if (!pack) continue
    for (const piece of pack.manifest.pieces) {
      const path = piece.cover ?? piece.pages[0]?.image
      byTitle.set(piece.title.trim(), {
        date,
        piece,
        cover: path ? pack.files[path] : undefined,
      })
    }
  }
  // Map.set 覆盖已有键时保留的是「初次插入」的位置，所以不能靠插入顺序，
  // 必须显式按日期倒排才能让最近读的排在前面
  return [...byTitle.values()].sort((a, b) => b.date.localeCompare(a.date))
}

// ---- 设置 ----
const DEFAULT_SETTINGS: Settings = { pin: '123', childName: '' }

export const loadSettings = async (): Promise<Settings> => ({
  ...DEFAULT_SETTINGS,
  ...((await get<Partial<Settings>>('settings')) ?? {}),
})

export const saveSettings = (s: Settings) => set('settings', s)
