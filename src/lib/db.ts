/**
 * 本地存储。全部在 IndexedDB，没有任何后端。
 *
 * 键的约定：
 *   pack:<date>       任务包 { manifest, files: 路径 → blob 哈希 }
 *   blob:<sha256>     按内容寻址的图/音频。同一本书连着几天布置，只存一份
 *   progress:<date>   当天各篇进度
 *   rec:<date>:<pid>  孩子交的录音 Blob
 *   stars:<date>      家长打的星
 *   done:<date>       当天全部篇目都读完了 —— 真正的「打卡章」
 *   settings          PIN、孩子名字
 *   schemaVersion     数据结构版本，升级时用来判断要不要迁移
 *   dates             有任务包的日期列表（升序），日历和图书馆都用
 */
import { get, set, del, keys, getMany, setMany, delMany } from 'idb-keyval'
import type { DayProgress, PackManifest, PackPiece, Settings } from '../types'
import { emptyProgress } from '../types'

export interface StoredPack {
  manifest: PackManifest
  /** 包内相对路径 → Blob（读出来时已解析好，调用方不需要关心底层怎么存） */
  files: Record<string, Blob>
}

/**
 * 存在库里的样子：files 的值是 blob 哈希而不是 Blob 本身。
 *
 * v1 的老包这里直接存 Blob，所以两种值都要认（见 resolveFiles）—— 这是
 * 迁移能中断、能重跑的关键：半迁移状态下 App 完全可用。
 */
interface RawPack {
  manifest: PackManifest
  files: Record<string, Blob | string>
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
const SCHEMA_VERSION = 2

export async function migrate(): Promise<{ from: number; to: number; steps: string[]; failed: string[] }> {
  const from = (await get<number>('schemaVersion')) ?? 0
  const steps: string[] = []
  if (from === SCHEMA_VERSION) return { from, to: SCHEMA_VERSION, steps, failed: [] }

  // from < 1：browsed 是后加的字段，但 loadProgress 会补默认值，不必改写数据。
  // 这一版只是把基线版本号落下来，供以后的迁移判断。
  if (from < 1) steps.push('v1 基线')

  // v1 → v2：任务包里的 Blob 挪到按内容寻址的 blob: 键下，包只留哈希。
  //
  // 一天一个包地转，每转完一个就立刻写回 pack 记录 —— 旧的 Blob 副本随之
  // 被释放，所以峰值只比原来多占一个包（十几 MB），不会翻倍。
  // 中途被杀也不怕：已转的是新格式、没转的还是老格式，而 resolveFiles
  // 两种都认，下次打开接着转。
  const failed: string[] = []
  if (from < 2) {
    let moved = 0
    for (const date of await listPackDates()) {
      // 逐包容错：一个坏包（配额不足、WebCrypto 不可用、记录损坏）不能连累其他包，
      // 更不能把整个启动流程带崩 —— 读取层本来就兼容两种格式，迁移是可选的
      try {
        const raw = await get<RawPack>(`pack:${date}`)
        if (!raw) continue
        const blobPaths = Object.keys(raw.files).filter((k) => typeof raw.files[k] !== 'string')
        if (!blobPaths.length) continue // 这个包已经是新格式了
        await savePack({ manifest: raw.manifest, files: await resolveFiles(raw.files) })
        moved++
      } catch {
        failed.push(date)
      }
    }
    steps.push(`v2 任务包转为按内容寻址（成功 ${moved} 个${failed.length ? `，失败 ${failed.length} 个` : ''}）`)
  }

  // 有失败就不升版本号，下次打开自动重试。已转好的包会被跳过，所以重试很便宜；
  // 硬盘腾出空间后自己就能好，不需要人工干预
  if (!failed.length) await set('schemaVersion', SCHEMA_VERSION)
  return { from, to: SCHEMA_VERSION, steps, failed }
}

/**
 * 最近一次迁移的结果。启动时迁移是「尽力而为」，失败也要让 App 起来，
 * 所以把结果记在内存里给家长页看 —— 不写库，因为写库可能正是失败的原因。
 */
let lastMigration: { failed: string[]; steps: string[] } | null = null
export const getMigrationStatus = () => lastMigration
export const setMigrationStatus = (v: { failed: string[]; steps: string[] }) => {
  lastMigration = v
}

/** 存储占用明细，家长页展示用 */
export const storageFootprint = async () => {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string')
  let bookBytes = 0
  let blobs = 0
  for (const k of ks) {
    if (!k.startsWith('blob:')) continue
    const b = await get<Blob>(k)
    if (!b) continue
    bookBytes += b.size
    blobs++
  }
  return { blobs, bookBytes, packs: (await listPackDates()).length }
}

// ---- 按内容寻址的 blob 存储 ----
/**
 * 同一本书常常连着好几天布置（亲子共读那本每天都带），一本 16 页的高清绘本
 * 约 9 MB，按天各存一份的话一周就白占 50 MB，而且会一直长下去。
 * 所以图和音频按内容哈希存一份，任务包只存引用。
 */
const blobKey = (hash: string) => `blob:${hash}`

async function sha256(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const d = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 把存的形态（哈希 or 老包里的 Blob）解析成调用方要的 Blob */
async function resolveFiles(files: Record<string, Blob | string>): Promise<Record<string, Blob>> {
  const paths = Object.keys(files)
  const hashPaths = paths.filter((p) => typeof files[p] === 'string')
  const fetched = hashPaths.length
    ? await getMany<Blob | undefined>(hashPaths.map((p) => blobKey(files[p] as string)))
    : []

  const out: Record<string, Blob> = {}
  for (const path of paths) {
    const v = files[path]
    if (typeof v !== 'string') {
      out[path] = v // v1 老包：直接就是 Blob
      continue
    }
    const blob = fetched[hashPaths.indexOf(path)]
    // 缺了就跳过这一项：阅读页对缺图有兜底（显示「这一页的图片丢了」），
    // 总比整本打不开好
    if (blob) out[path] = blob
  }
  return out
}

// ---- 任务包 ----
export const savePack = async (pack: StoredPack) => {
  const date = pack.manifest.date

  // 先算哈希、只写库里还没有的 blob，再写 pack 记录。
  // 顺序很重要：pack 记录一旦落下，它引用的 blob 必须都已经在了
  const paths = Object.keys(pack.files)
  const hashes = await Promise.all(paths.map((p) => sha256(pack.files[p])))
  const existing = await getMany<Blob | undefined>(hashes.map(blobKey))
  const toWrite: [string, Blob][] = []
  const seen = new Set<string>()
  hashes.forEach((h, i) => {
    if (existing[i] || seen.has(h)) return // 库里有了，或本包内重复
    seen.add(h)
    toWrite.push([blobKey(h), pack.files[paths[i]]])
  })
  if (toWrite.length) await setMany(toWrite)

  const raw: RawPack = {
    manifest: pack.manifest,
    files: Object.fromEntries(paths.map((p, i) => [p, hashes[i]])),
  }
  // pack 记录和 dates 索引必须一个事务写完：分两次写的话中间被杀会留下
  // 「包在库里但不在索引里」的状态
  const all = new Set(await listPackDates())
  all.add(date)
  await setMany([
    [`pack:${date}`, raw],
    ['dates', [...all].sort()],
  ])

  // 同日期重新导入会顶掉旧包，旧包独有的 blob 就没人引用了
  await gcBlobs()
}

export const loadPack = async (date: string): Promise<StoredPack | undefined> => {
  const raw = await get<RawPack>(`pack:${date}`)
  if (!raw) return undefined
  return { manifest: raw.manifest, files: await resolveFiles(raw.files) }
}

/** 只要 manifest 和引用表，不读 blob 内容。书架列书用这个，快得多 */
const loadPackMeta = (date: string) => get<RawPack>(`pack:${date}`)

export const listPackDates = async () => (await get<string[]>('dates')) ?? []

/**
 * 删包只删 pack 记录，**绝不顺手删 blob** —— blob 是多天共享的，
 * 误删会把别的天的图悄悄弄没。交给 gcBlobs 统一算引用。
 */
export const deletePack = async (date: string) => {
  await del(`pack:${date}`)
  await set('dates', (await listPackDates()).filter((d) => d !== date))
  await gcBlobs()
}

/**
 * 标记-清扫：重算「还被任何任务包引用」的 blob，只删没人引用的。
 * 不读 blob 内容，只比键，所以很便宜。
 */
export const gcBlobs = async (): Promise<{ removed: number }> => {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string')
  const referenced = new Set<string>()
  // 引用源是**库里实际存在的 pack: 记录**，不是 dates 索引。索引要是漂了
  // （历史遗留、或写索引前被杀），按索引统计就会漏掉一个真包，
  // 进而把它的素材当孤儿删掉 —— 那本书就静默变成空白页了
  for (const k of ks) {
    if (!k.startsWith('pack:')) continue
    const raw = await get<RawPack>(k)
    if (!raw?.files) continue
    for (const v of Object.values(raw.files)) {
      if (typeof v === 'string') referenced.add(blobKey(v))
    }
  }
  const orphans = ks.filter((k) => k.startsWith('blob:') && !referenced.has(k))
  if (orphans.length) await delMany(orphans)
  return { removed: orphans.length }
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
  // 先只读 manifest + 引用表（不含 blob 内容），把要哪些封面定下来
  const wanted: { key: string; title: string }[] = []
  for (const date of await listPackDates()) {
    // listPackDates 是升序，所以后面的（更新的）会自然覆盖前面的同名书
    const raw = await loadPackMeta(date)
    if (!raw) continue
    for (const piece of raw.manifest.pieces) {
      const path = piece.cover ?? piece.pages[0]?.image
      const ref = path ? raw.files[path] : undefined
      byTitle.set(piece.title.trim(), { date, piece })
      if (typeof ref === 'string') wanted.push({ key: `blob:${ref}`, title: piece.title.trim() })
      else if (ref) byTitle.get(piece.title.trim())!.cover = ref // v1 老包
    }
  }
  // 只把封面这一张图读进来 —— 早先是整包解析，等于为了列书架把全部素材
  // （近百 MB）都读一遍
  if (wanted.length) {
    const covers = await getMany<Blob | undefined>(wanted.map((w) => w.key))
    wanted.forEach((w, i) => {
      const book = byTitle.get(w.title)
      if (book && covers[i]) book.cover = covers[i]
    })
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
