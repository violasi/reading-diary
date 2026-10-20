/**
 * 本地存储。全部在 IndexedDB，没有任何后端。
 *
 * 键的约定：
 *   pack:<date>       当日任务包 { manifest, files: 路径 → blob 哈希 }
 *   pack:lib/<系列名>  系列包：一次性导入的一整套书，不绑定任何一天。
 *                     **必须也用 pack: 前缀** —— gcBlobs 是扫所有 pack: 开头的键
 *                     来算引用的，换个前缀它认不出来，会把整套系列的素材当孤儿删光
 *   blob:<sha256>     按内容寻址的图/音频。同一本书连着几天布置，只存一份
 *   thumb:<sha256>    封面缩略图（宽 160px，WebP）。书架显示的是 36~100px 的小图，
 *                     用整页原图（一张约 150 KB）上百本要十几 MB，平板上卡好几秒。
 *                     首次用到时生成并缓存；对应 blob 被回收时一起回收
 *   progress:<date>   当天各篇进度
 *   rec:<date>:<pid>  孩子交的录音 Blob
 *   extra:<date>      当天孩子自己从书架挑着读完的书（当日任务之外的）
 *   stars:<date>      家长打的星
 *   done:<date>       当天至少读完一本 —— 打卡章。注意日历不只看这个键，
 *                     loadDoneDates 还会扫 progress: 取并集（见那里的说明）
 *   genGroups         家长上次勾选的「从哪些分组抽书」
 *   planModes         家长上次选的抽书方式（中/英各一个：1新1旧 / 2新 / 2旧）
 *   settings          PIN、孩子名字
 *   schemaVersion     数据结构版本，升级时用来判断要不要迁移
 *   dates             有当日任务包的日期列表（升序），日历和图书馆都用
 *   series            已导入的系列列表（存的是 lib/<系列名> 这种槽位名）
 */
import { get, set, del, keys, getMany, setMany, delMany } from 'idb-keyval'
import type { DayProgress, PackManifest, PackPiece, Settings } from '../types'
import { emptyProgress, groupOf, isPieceDone, langOf } from '../types'

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

/** 日历上的前一天。用本地时间加减，和 todayStr 保持同一套时区口径 */
export const prevDay = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return todayStr(new Date(y, m - 1, d - 1))
}

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
const THUMB_W = 160
const thumbKey = (blobK: string) => `thumb:${blobK.slice(5)}`

/**
 * 生成封面缩略图。
 *
 * ⚠ 两件事都是实测踩出来的：
 * 1. **必须用 WebP 编码**。同一张图 canvas→JPEG 约 1000 ms/张、canvas→WebP 约
 *    9 ms/张，差 110 倍。convertToBlob 和 toBlob 编 JPEG 都慢得离谱。
 * 2. **OffscreenCanvas 不能假定存在**。老一点的安卓 WebView 没有它；一旦这里
 *    返回 undefined，调用方每次都退回读整页原图（一张 150 KB），缩略图缓存
 *    形同虚设，书架会一直慢。所以依次退：OffscreenCanvas → 普通 canvas.toBlob
 *    → canvas.toDataURL，最后才放弃。
 *
 * 解码时就让它出小图（resizeWidth），省一次整张大图的解码和内存。
 */
let thumbMode: 'offscreen' | 'canvas' | 'dataurl' | 'none' | null = null
export const getThumbMode = () => thumbMode

async function makeThumb(blob: Blob): Promise<Blob | undefined> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(blob, { resizeWidth: THUMB_W, resizeQuality: 'medium' })
  } catch {
    try {
      bmp = await createImageBitmap(blob)
    } catch {
      return undefined
    }
  }
  const scale = Math.min(1, THUMB_W / bmp.width)
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))

  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const cv = new OffscreenCanvas(w, h)
      const ctx = cv.getContext('2d')
      if (ctx) {
        ctx.drawImage(bmp, 0, 0, w, h)
        bmp.close()
        thumbMode = 'offscreen'
        return await cv.convertToBlob({ type: 'image/webp', quality: 0.82 })
      }
    }
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d')
    if (!ctx) {
      bmp.close()
      thumbMode = 'none'
      return undefined
    }
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const viaToBlob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/webp', 0.82))
    if (viaToBlob) {
      thumbMode = 'canvas'
      return viaToBlob
    }
    const url = cv.toDataURL('image/webp', 0.82)
    if (url.startsWith('data:image/webp')) {
      thumbMode = 'dataurl'
      return await (await fetch(url)).blob()
    }
    thumbMode = 'none'
    return undefined
  } catch {
    try {
      bmp.close()
    } catch {
      /* 已经关过了 */
    }
    thumbMode = 'none'
    return undefined
  }
}

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
/**
 * 系列包在 pack: 命名空间里的槽位前缀。
 *
 * 为什么不另开一个 `lib:` 前缀：gcBlobs 认的是 `pack:` 开头的键，
 * 别的前缀它扫不到，整套系列的图和音频会被当成孤儿删掉 —— 书还留在书架上，
 * 点开却全是空白页。沿用 pack: 前缀，那个最危险的函数一行都不用动。
 */
const SERIES_PREFIX = 'lib/'
export const seriesSlot = (name: string) => SERIES_PREFIX + name.trim()
export const isSeriesSlot = (slot: string) => slot.startsWith(SERIES_PREFIX)
export const seriesName = (slot: string) => slot.slice(SERIES_PREFIX.length)
export const listSeriesSlots = async () => (await get<string[]>('series')) ?? []
/** 库里所有包的槽位：当日包（日期）+ 系列包（lib/…） */
const allSlots = async () => [...(await listPackDates()), ...(await listSeriesSlots())]

// ---- 书目索引 ----
/**
 * 书架和「生成计划」只要书名、分组、封面键这几样，**从不碰页面内容**。
 * 可这些字段散在每个 pack 记录里，而一条 pack 记录装着整本书的页文本
 * 加上几百条「路径 → 哈希」映射（实测全库 5730 条）—— 为了拿一行标题，
 * 得把几兆结构化数据反序列化一遍。Mac 上几十毫秒无感，平板上就是点开
 * 书架干等好几秒，而且包越多越慢。
 *
 * 所以单独落一份精简索引，书架改成**一次小读**。
 *
 * 按槽位分块存：导入新包时只改它那一块，不用重扫全库。书名撞车
 * （同一本书既在系列包又在当日包里）留到读出来之后在内存里去重 ——
 * 去重规则要是写进存储，改规则就得重建索引。
 */
const BOOK_INDEX_KEY = 'bookIndex'
const BOOK_INDEX_V = 1

export interface IndexedBook {
  pieceId: string
  title: string
  lang: 'zh' | 'en'
  group: string
  level?: string
  seq?: number
  /** 多少页。书架要显示，单独记一个数字，省得为它去读整本的 pages */
  pages: number
  /** 封面 blob 的键 */
  coverRef?: string
  /** v1 老包的封面是直接塞在包记录里的 Blob，没有哈希键；记下路径，要用时回包里取 */
  coverPath?: string
}

type BookIndex = { v: number; bySlot: Record<string, IndexedBook[]> }

const indexEntries = (raw: RawPack): IndexedBook[] =>
  raw.manifest.pieces.map((piece) => {
    const path = piece.cover ?? piece.pages[0]?.image
    const ref = path ? raw.files[path] : undefined
    const e: IndexedBook = {
      pieceId: piece.id,
      title: piece.title.trim(),
      lang: langOf(piece),
      group: groupOf(piece),
      level: piece.level,
      seq: piece.seq,
      pages: piece.pages.length,
    }
    if (typeof ref === 'string') e.coverRef = blobKey(ref)
    else if (ref && path) e.coverPath = path // v1 老包
    return e
  })

/**
 * 读索引，顺手和真实的槽位列表对一遍：缺的补上、多的删掉。
 *
 * 对账是为了自愈 —— 老版本升上来时索引还不存在，或者哪次写到一半被杀，
 * 都在这里补回来，不用人工清缓存。补的时候只读缺的那几个包，所以除了
 * 升级后的第一次，这里永远只有一次 get。
 */
const loadBookIndex = async (): Promise<Record<string, IndexedBook[]>> => {
  const stored = await get<BookIndex>(BOOK_INDEX_KEY)
  const bySlot = stored?.v === BOOK_INDEX_V ? { ...stored.bySlot } : {}
  const slots = await allSlots()
  const live = new Set(slots)
  let dirty = false

  for (const slot of Object.keys(bySlot))
    if (!live.has(slot)) {
      delete bySlot[slot]
      dirty = true
    }
  for (const slot of slots) {
    if (bySlot[slot]) continue
    const raw = await loadPackMeta(slot)
    bySlot[slot] = raw ? indexEntries(raw) : []
    dirty = true
  }
  if (dirty) await set(BOOK_INDEX_KEY, { v: BOOK_INDEX_V, bySlot } satisfies BookIndex)
  return bySlot
}

/**
 * 导入/删包后就地改索引里对应的那一块。
 *
 * 索引还没建过就直接跳过 —— 下次 loadBookIndex 会整个建起来，
 * 在这儿抢着建等于把全库扫描挪到导入流程里。
 */
const patchBookIndex = async (slot: string, entries: IndexedBook[] | null) => {
  const stored = await get<BookIndex>(BOOK_INDEX_KEY)
  if (stored?.v !== BOOK_INDEX_V) return
  const bySlot = { ...stored.bySlot }
  if (entries) bySlot[slot] = entries
  else delete bySlot[slot]
  await set(BOOK_INDEX_KEY, { v: BOOK_INDEX_V, bySlot } satisfies BookIndex)
}

export const savePack = async (pack: StoredPack) => {
  const { date, series } = pack.manifest
  if (!date && !series) throw new Error('任务包既没有日期也没有系列名')
  // 系列包不进 dates 索引 —— 进了的话日历上会冒出个假日子
  const slot = series ? seriesSlot(series) : date!

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
  const indexKey = series ? 'series' : 'dates'
  const all = new Set(series ? await listSeriesSlots() : await listPackDates())
  all.add(slot)
  await setMany([
    [`pack:${slot}`, raw],
    [indexKey, [...all].sort()],
  ])

  // 书目索引跟着改这一块，书架下次打开照样只读一次
  await patchBookIndex(slot, indexEntries(raw))

  // 同槽位重新导入会顶掉旧包，旧包独有的 blob 就没人引用了
  await gcBlobs()
}

/** slot 可以是日期（当日包），也可以是 lib/<系列名>（系列包） */
export const loadPack = async (slot: string): Promise<StoredPack | undefined> => {
  const raw = await get<RawPack>(`pack:${slot}`)
  if (!raw) return undefined
  return { manifest: raw.manifest, files: await resolveFiles(raw.files) }
}

/** 只要 manifest 和引用表，不读 blob 内容。书架列书用这个，快得多 */
const loadPackMeta = (slot: string) => get<RawPack>(`pack:${slot}`)

export const listPackDates = async () => (await get<string[]>('dates')) ?? []

/**
 * 删包只删 pack 记录，**绝不顺手删 blob** —— blob 是多天共享的，
 * 误删会把别的天的图悄悄弄没。交给 gcBlobs 统一算引用。
 */
export const deletePack = async (date: string) => {
  await del(`pack:${date}`)
  await set('dates', (await listPackDates()).filter((d) => d !== date))
  await patchBookIndex(date, null)
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
  // 缩略图跟着它的原图走：原图没人引用了，缩略图也该走
  const liveThumbs = new Set([...referenced].map(thumbKey))
  const deadThumbs = ks.filter((k) => k.startsWith('thumb:') && !liveThumbs.has(k))
  const dead = [...orphans, ...deadThumbs]
  if (dead.length) await delMany(dead)
  return { removed: orphans.length }
}

/**
 * 某一天读了什么 + 得了几星。「我的」页点日历回顾用。
 *
 * 只读 manifest 和星星，**不碰任何图和音频** —— 回顾历史只需要书名，
 * 把那天的素材整包解析出来纯属浪费（一天可能十几 MB）。
 */
export const loadDaySummary = async (date: string) => {
  const [raw, stars, done, prog, extra] = await Promise.all([
    loadPackMeta(date),
    loadStars(date),
    get<boolean>(`done:${date}`),
    loadProgress(date),
    loadExtraReads(date),
  ])
  return {
    date,
    done: !!done || extra.length > 0,
    books: [
      ...(raw?.manifest.pieces ?? []).map((p) => ({
        id: p.id,
        title: p.title,
        pages: p.pages.length,
        stars: stars[p.id] ?? 0,
        finished: isPieceDone(prog[p.id] ?? emptyProgress()),
        recorded: !!(prog[p.id] ?? emptyProgress()).recorded,
        /** 孩子自己从书架挑的，不是当天布置的任务 */
        extra: false,
      })),
      // 自选阅读排在任务后面：任务是当天的正事，这些是额外读的
      ...extra.map((e) => ({
        id: `extra:${e.pieceId}`,
        title: e.title,
        pages: e.pages,
        stars: 0,
        finished: true,
        recorded: false,
        extra: true,
      })),
    ],
  }
}

// ---- 进度 ----
/**
 * 读出来一律补齐字段，这样以后加新字段不会把老记录读成 undefined。
 *
 * finished 是取消关卡后才有的字段。关卡时代的记录没有它，但那时的「读完」
 * 等价于「交了录音」（有声书）或「浏览完了」（纯图绘本）—— 在这里推导出来，
 * 老日子的日历和星星就不会因为改版而回退。不写迁移：推导比改写数据安全，
 * 而且孩子点过一次「读完了」之后就会存下真正的 finished。
 */
export const loadProgress = async (date: string): Promise<DayProgress> => {
  const raw = (await get<Record<string, Partial<DayProgress[string]>>>(`progress:${date}`)) ?? {}
  const out: DayProgress = {}
  for (const [id, p] of Object.entries(raw)) {
    const merged = { ...emptyProgress(), ...p }
    // 关卡时代的记录没有 finished，那时的「读完」= 交了录音 / 浏览完了
    if (p.finished === undefined) merged.finished = !!(p.recorded || p.browsed)
    // 交了录音就算读完 —— 这一条**无条件**补，不能只在 finished 缺失时补。
    // 中间有一版（取消关卡但录音还不算读完）已经写下了显式的 finished: false，
    // 那版交过的录音会留下 { recorded: true, finished: false }，
    // 只看 undefined 的话这些书升级后仍显示没读完。
    if (merged.recorded) merged.finished = true
    out[id] = merged
  }
  return out
}

export const saveProgress = (date: string, p: DayProgress) => set(`progress:${date}`, p)

// ---- 打卡章 ----
/**
 * 「读了哪几天」以这个为准。
 *
 * 判据是**当天至少有一本书读完**，不要求全部读完 —— 一天布置三四本，孩子只读了
 * 两本也是读了，日历上那天就该有章。具体读完哪几本在「我的」页的星星区标出来，
 * 章负责「这天有没有读」，星星区负责「读了哪些」。
 */
export const markDayDone = (date: string) => set(`done:${date}`, true)

/**
 * 哪几天有章。两个来源取并集：
 *   1. done:<date> 键 —— 当天读完时写下的
 *   2. 扫 progress:<date>，只要有任一本 finished 就算
 *
 * 第 2 条不是冗余：盖章规则从「全部读完」放宽到「至少读完一本」之前，
 * 那些「只读完一两本」的日子根本没写过 done: 键。光读键的话，改版后这些
 * 历史日期在日历和连续天数里仍然是漏的。扫 progress 也比依赖 pack 稳 ——
 * 万一哪天的包被换掉了，孩子读过的事实还在 progress 里。
 */
export const loadDoneDates = async () => {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string')
  const out = new Set<string>()
  for (const k of ks) {
    if (k.startsWith('done:')) out.add(k.slice('done:'.length))
    // 只从书架挑着读的那天，当日任务可能一本没动，章全靠这个键
    else if (k.startsWith('extra:')) out.add(k.slice('extra:'.length))
  }
  for (const k of ks) {
    if (!k.startsWith('progress:')) continue
    const date = k.slice('progress:'.length)
    if (out.has(date)) continue
    const prog = await loadProgress(date) // 走 loadProgress，才能吃到上面那些兼容推导
    if (Object.values(prog).some(isPieceDone)) out.add(date)
  }
  return [...out].sort()
}

// ---- 书架自选阅读 ----
/**
 * 孩子自己从书架挑的书，读完了也算当天读过。
 *
 * **为什么不写进 progress:<date>**：piece id 是每个包各自从 p1 编起的
 * （实测 69 个包全都在用 p1…p15），书架那本的 id 几乎必然和当天任务里的某一本
 * 撞号，写进去会把进度串到别的书上。所以单开一个键，条目自带书名和出处。
 *
 * 按书名去重 —— 同一本书在好几个包里都有，但对孩子来说就是同一本。
 */
export interface ExtraRead {
  /** 内容在哪个包里，配合 pieceId 能找回原书 */
  slot: string
  pieceId: string
  title: string
  lang: 'zh' | 'en'
  pages: number
}

export const loadExtraReads = async (date: string) =>
  (await get<ExtraRead[]>(`extra:${date}`)) ?? []

/** 记一本，并盖上当天的打卡章。重复读同一本不会记两条 */
export const addExtraRead = async (date: string, book: ExtraRead) => {
  const list = await loadExtraReads(date)
  if (list.some((x) => x.title === book.title)) return list
  const next = [...list, book]
  await set(`extra:${date}`, next)
  await markDayDone(date)
  return next
}

/** 哪些天有自选阅读。和 loadDoneDates 一样靠扫键，不依赖额外索引 */
const listExtraDates = async () =>
  (await keys())
    .filter((k): k is string => typeof k === 'string' && k.startsWith('extra:'))
    .map((k) => k.slice('extra:'.length))

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
    del(`extra:${date}`),
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
      k.startsWith('extra:') ||
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

/** 书架上的一本书：索引里那几样 + 内容在哪个包里 */
export interface LibraryBook extends IndexedBook {
  /** 这本书最近一次出现在哪个包里（日期，或系列包的 lib/<系列名>） */
  slot: string
}

/**
 * 图书馆：所有导入过的书，不管有没有交过录音。
 *
 * 按书名去重 —— 同一本书常常连着好几天都在任务包里（有的书要看很多天），
 * 书架上只该有一本。
 *
 * **只读一次索引**，不碰 pack 记录（为什么见 BOOK_INDEX_KEY 那段注释）。
 */
/**
 * 把索引按书名合并成「一本书一条」。listLibrary 和 buildCatalogue 共用。
 *
 * **两件事来源不同，别混**：
 * - 内容在哪个包里（slot/pieceId）取**最近的当日包** —— 那才是孩子真正读的那份；
 * - 分组和难度序号（group/seq）取**系列包** —— 它明确带了 series/seq，权威。
 *
 * 分组必须以系列包为准，是因为当日包只有 `level`，而同一套书在不同日子的包里
 * 叫法并不统一（有几本写成「牛津树自然拼读 Level 5」，系列包里是「Stage 4」）。
 * 照当日包分组，书架上就会凭空多出几个只有一本书的组。
 *
 * 这两边以前各写了一份，结果书架有这个 bug、家长选书没有 —— 所以合到一处。
 */
const mergeBooks = (bySlot: Record<string, IndexedBook[]>): Map<string, LibraryBook> => {
  const byTitle = new Map<string, LibraryBook>()
  /** 书名 → 系列包给的分组和序号 */
  const fromSeries = new Map<string, { group: string; seq?: number }>()

  // 系列包先放、当日包后放，同名时让当日包那份胜出（内容取最近读的那份）
  const slots = Object.keys(bySlot).sort((x, y) => {
    const sx = isSeriesSlot(x),
      sy = isSeriesSlot(y)
    if (sx !== sy) return sx ? -1 : 1
    return x.localeCompare(y) // 日期升序，后放的（更新的）覆盖先放的
  })
  for (const slot of slots)
    for (const e of bySlot[slot]) {
      if (!e.title) continue
      if (isSeriesSlot(slot)) fromSeries.set(e.title, { group: e.group, seq: e.seq })
      byTitle.set(e.title, { ...e, slot })
    }

  // 分组拨回系列包的叫法；seq 只补不覆盖（当日包自己带了 seq 就信它）
  for (const [title, meta] of fromSeries) {
    const e = byTitle.get(title)
    if (!e) continue
    e.group = meta.group
    if (e.seq === undefined) e.seq = meta.seq
  }
  return byTitle
}

export const listLibrary = async (): Promise<LibraryBook[]> => {
  const books = [...mergeBooks(await loadBookIndex()).values()]
  // Map.set 覆盖已有键时保留的是「初次插入」的位置，所以不能靠插入顺序，
  // 必须显式按日期倒排才能让最近读的排在前面。
  // 系列包没有日期（槽位是 lib/…），按字典序会压在最前面，所以单独排到后面去
  return books.sort((x, y) => {
    const sx = isSeriesSlot(x.slot),
      sy = isSeriesSlot(y.slot)
    if (sx !== sy) return sx ? 1 : -1
    return y.slot.localeCompare(x.slot)
  })
}

/**
 * 按需取封面，优先用缓存的缩略图；没有就现做一份并缓存。
 * 书架只给**当前要显示的那几本**调这个 —— 折叠时是每组第一本，展开时再取那一组。
 */
export const loadCovers = async (
  books: LibraryBook[],
  /** 每取到一张就回调一次。书架用它做**渐进显示** —— 全部做完才一起显示的话，
   *  首次打开会空白好几秒（一张缩略图要 30 ms 上下，十几张就是半秒到几秒） */
  onOne?: (title: string, blob: Blob) => void,
): Promise<Map<string, Blob>> => {
  const out = new Map<string, Blob>()
  const need: { key: string; title: string }[] = []
  /** v1 老包：封面 Blob 躺在包记录里，没有哈希键可查，只能回包里捞 */
  const legacy: LibraryBook[] = []
  for (const b of books) {
    if (b.coverRef) need.push({ key: b.coverRef, title: b.title })
    else if (b.coverPath) legacy.push(b)
  }

  // 老包极少（迁移过的都没有），放最后慢慢捞，不挡住新包那批
  const sweepLegacy = async () => {
    for (const b of legacy) {
      const f = (await loadPackMeta(b.slot))?.files[b.coverPath!]
      if (!(f instanceof Blob)) continue
      const th = (await makeThumb(f)) ?? f
      out.set(b.title, th)
      onOne?.(b.title, th)
    }
  }
  if (!need.length) {
    await sweepLegacy()
    return out
  }

  const thumbs = await getMany<Blob | undefined>(need.map((n) => thumbKey(n.key)))
  const miss: { key: string; title: string }[] = []
  need.forEach((n, i) => {
    if (thumbs[i]) {
      out.set(n.title, thumbs[i]!)
      onOne?.(n.title, thumbs[i]!)
    } else miss.push(n)
  })
  if (!miss.length) {
    await sweepLegacy()
    return out
  }

  const fulls = await getMany<Blob | undefined>(miss.map((m) => m.key))
  const toCache: [string, Blob][] = []
  for (let i = 0; i < miss.length; i++) {
    const full = fulls[i]
    if (!full) continue
    const th = await makeThumb(full)
    out.set(miss[i].title, th ?? full) // 做不出来就退回原图，至少有封面
    onOne?.(miss[i].title, th ?? full)
    if (th) toCache.push([thumbKey(miss[i].key), th])
  }
  if (toCache.length) await setMany(toCache)
  await sweepLegacy()
  return out
}

/**
 * 后台预热缩略图：把还没缓存的逐批做好，**不返回内容**。
 *
 * 必须等前台那几张画出来之后再调 —— 一上来就排 80 多张，会把文件夹图标挤到
 * 二十几秒后才出现（实测踩过）。每批之间让出主线程。
 */
export const warmCovers = async (books: LibraryBook[], shouldStop?: () => boolean) => {
  const keys = books.map((b) => b.coverRef).filter((k): k is string => !!k)
  if (!keys.length) return
  const have = await getMany<Blob | undefined>(keys.map(thumbKey))
  const todo = keys.filter((_, i) => !have[i])
  for (let i = 0; i < todo.length; i += 3) {
    if (shouldStop?.()) return
    const batch = todo.slice(i, i + 3)
    const fulls = await getMany<Blob | undefined>(batch)
    const out: [string, Blob][] = []
    for (let j = 0; j < batch.length; j++) {
      const full = fulls[j]
      if (!full) continue
      const th = await makeThumb(full)
      if (th) out.push([thumbKey(batch[j]), th])
    }
    if (out.length) await setMany(out)
    await new Promise((r) => setTimeout(r, 30))
  }
}

/**
 * 书架封面缩略图缓存情况。家长页摆出来 —— 书架慢不慢全看这个缓存建没建起来，
 * 出问题时一眼能看出是「还没补完」还是「这台设备压根生成不了」。
 *
 * 能力是**当场探一张小图**，不依赖模块内记录的状态（家长页和书架可能拿到
 * 不同的模块实例，那个状态会是 unknown）。
 */
export const coverCacheStatus = async () => {
  const lib = await listLibrary()
  const refs = lib.map((b) => b.coverRef).filter((k): k is string => !!k)
  const have = await getMany<Blob | undefined>(refs.map(thumbKey))
  let mode = 'none'
  try {
    const probe = new Blob(
      [Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0))],
      { type: 'image/gif' },
    )
    if (await makeThumb(probe)) mode = thumbMode ?? 'ok'
  } catch {
    mode = 'none'
  }
  return { cached: have.filter(Boolean).length, total: refs.length, mode }
}

// ---- 书目总表 & 当日计划生成 ----
/**
 * 一本书在总表里的样子。**身份是书名**（和书架的去重规则一致）。
 */
export interface CatalogEntry {
  title: string
  lang: 'zh' | 'en'
  /** 家长勾选的粒度：系列优先，回退到分级（见 types.ts 的 groupOf） */
  group: string
  level?: string
  seq?: number
  /** 内容在哪个包里（日期或 lib/<系列名>），以及在那个包里的 piece id */
  slot: string
  pieceId: string
  /** 最近一次**读完**的日期。undefined = 还没读过 = 新书 */
  lastRead?: string
}

/**
 * 难度序号，越小越简单，给「新书从易到难」排序用。
 *
 * ⚠ 这是对已有数据的**推断**，不是权威顺序：
 *   · 系列包带 seq 的，直接用 seq —— 这个是准的
 *   · 老包只有 level 字符串，从里面抠：「… Stage 3」「… Level 4」取数字，
 *     「RAZ Level B」取字母序
 *   · 同一分级内部（比如 39 本 RAZ B）老包里没有任何顺序信息，只能并列，
 *     再按书名稳定排序
 */
const rankOf = (e: { seq?: number; level?: string }): number => {
  if (typeof e.seq === 'number') return e.seq
  const lv = e.level ?? ''
  const num = lv.match(/(?:Stage|Level)\s*(\d+)/i)
  if (num) return Number(num[1]) * 100
  const letter = lv.match(/Level\s*([A-Za-z])\b/)
  if (letter) return (letter[1].toUpperCase().charCodeAt(0) - 64) * 100
  return 0
}

/**
 * 全部已知的书 + 读没读过。
 *
 * 读没读过只认**当日任务包的进度**（系列包不绑定日期，本身没有进度）。
 */
export const buildCatalogue = async (): Promise<CatalogEntry[]> => {
  const bySlot = await loadBookIndex()
  const dates = await listPackDates()
  const byTitle = new Map<string, CatalogEntry>()
  for (const [title, b] of mergeBooks(bySlot))
    byTitle.set(title, {
      title,
      lang: b.lang,
      group: b.group,
      level: b.level,
      seq: b.seq,
      slot: b.slot,
      pieceId: b.pieceId,
    })

  // 进度是按「哪天的包里的哪个 piece」记的，得顺着索引映射回书名。
  // 注意这里要走**每一个**当日包，不能只看合并后胜出的那个 slot ——
  // 一本书可能是在更早的某天读完的，那天的包才有它的进度
  for (const date of dates) {
    const entries = bySlot[date]
    if (!entries?.length) continue
    const prog = await loadProgress(date)
    const done = Object.entries(prog).filter(([, v]) => isPieceDone(v))
    if (!done.length) continue
    const m = new Map(entries.map((e) => [e.pieceId, e.title]))
    for (const [pid] of done) {
      const title = m.get(pid)
      const e = title ? byTitle.get(title) : undefined
      if (e && (!e.lastRead || date > e.lastRead)) e.lastRead = date
    }
  }

  // 孩子自己从书架挑着读完的也算读过 —— 不然下次生成计划还会把它当新书排给他。
  // 这些条目自带书名，不用再绕 pieceId 映射
  for (const date of await listExtraDates())
    for (const x of await loadExtraReads(date)) {
      const e = byTitle.get(x.title)
      if (e && (!e.lastRead || date > e.lastRead)) e.lastRead = date
    }

  return [...byTitle.values()]
}

/** 书库里有哪些分组可选，以及每组多少本、读过几本 */
export interface GroupStat {
  group: string
  lang: 'zh' | 'en'
  total: number
  unread: number
}
export const listGroups = async (cat?: CatalogEntry[]): Promise<GroupStat[]> => {
  const entries = cat ?? (await buildCatalogue())
  const m = new Map<string, GroupStat>()
  for (const e of entries) {
    const k = `${e.lang}\u0000${e.group}`
    const g = m.get(k) ?? { group: e.group, lang: e.lang, total: 0, unread: 0 }
    g.total++
    if (!e.lastRead) g.unread++
    m.set(k, g)
  }
  return [...m.values()].sort((a, b) => a.lang.localeCompare(b.lang) || a.group.localeCompare(b.group))
}

/**
 * 旧书从「最久没读的那几本」里随机一本。
 *
 * 候选窗口 = 最久没读的前三分之一，但**至少 3 本**、至多 6 本。
 * 下限 3 是必须的：早期旧书才两三本时，按 ⌈n/3⌉ 算窗口会塌成 1，
 * 于是每天抽到的都是同一本 —— 正是要避免的。窗口不超过书数。
 */
const pickOldest = (olds: CatalogEntry[]): CatalogEntry | undefined => {
  if (!olds.length) return undefined
  const n = Math.min(olds.length, 6, Math.max(3, Math.ceil(olds.length / 3)))
  return olds[Math.floor(Math.random() * n)]
}

export interface PlanPick {
  lang: 'zh' | 'en'
  kind: '新书' | '旧书' | '昨天'
  title: string
  group: string
}

/** 每种语言抽书的方式。家长按孩子当天状态选 */
export type PlanMode = '1新1旧' | '2新' | '2旧' | '昨天+新'
export const PLAN_MODES: PlanMode[] = ['1新1旧', '2新', '2旧', '昨天+新']
export const loadPlanModes = async () =>
  (await get<Record<'zh' | 'en', PlanMode>>('planModes')) ?? { zh: '1新1旧' as PlanMode, en: '1新1旧' as PlanMode }
export const savePlanModes = (m: Record<'zh' | 'en', PlanMode>) => set('planModes', m)

/**
 * 生成当日计划：中文、英文各一本新书 + 一本旧书。
 *
 * **不复制任何字节** —— blob 是按内容寻址的，生成出来的包只是一份新的 manifest，
 * 指向已经存在的 blob。所以下游（首页、阅读页、录音、打卡、书架）一行都不用改。
 *
 * 某一语种没有新书了，就挑两本旧书，一易一难。
 * 调用方要先处理「今天已经有进度」的情况：piece id 是重新编的（p1…p4），
 * 直接覆盖会让旧进度串到别的书上。
 */
export const generateDayPlan = async (
  date: string,
  groups: string[],
  modes: Record<'zh' | 'en', PlanMode> = { zh: '1新1旧', en: '1新1旧' },
): Promise<{ picks: PlanPick[]; empty: string[]; notes: string[] }> => {
  const cat = await buildCatalogue()
  const allow = new Set(groups)
  const chosen: CatalogEntry[] = []
  const picks: PlanPick[] = []
  const empty: string[] = []
  const notes: string[] = []

  for (const lang of ['zh', 'en'] as const) {
    const label = lang === 'zh' ? '中文' : '英文'
    const pool = cat.filter((e) => e.lang === lang && allow.has(e.group))
    if (!pool.length) {
      empty.push(label)
      continue
    }
    const take = (e: CatalogEntry | undefined, kind: PlanPick['kind']) => {
      if (!e || chosen.includes(e)) return false
      chosen.push(e)
      picks.push({ lang, kind, title: e.title, group: e.group })
      return true
    }
    const byRank = (a: CatalogEntry, b: CatalogEntry) =>
      rankOf(a) - rankOf(b) || a.title.localeCompare(b.title)
    const news = pool.filter((e) => !e.lastRead).sort(byRank)
    const olds = pool.filter((e) => e.lastRead).sort((a, b) => a.lastRead!.localeCompare(b.lastRead!))

    const want = modes[lang] ?? '1新1旧'

    /**
     * 「昨天」那本：上一次布置的那天的书，用来隔天再读一遍读得不顺的。
     *
     * 认的是**上一个有任务包的日子**，不是日历上的昨天 —— 中间跳过几天
     * （出门、生病）照样能复习到上次那本。
     *
     * 不走 cat 里的 slot：今天的包要是已经生成过一次，昨天那本的 slot 会被
     * 今天这份顶掉，就找不回来了。直接查索引里那一天的条目。
     *
     * 两本里挑哪本：优先挑**没标读完**的那本（读得不顺往往就没点「读完了」），
     * 都读完了就挑难的那本。
     */
    let prevPick: CatalogEntry | undefined
    let prevDate: string | undefined
    if (want === '昨天+新') {
      prevDate = (await listPackDates()).filter((d) => d < date).sort().pop()
      if (prevDate) {
        const prog = await loadProgress(prevDate)
        const idx = (await loadBookIndex())[prevDate] ?? []
        const mine = idx
          .map((e) => ({ e, c: pool.find((x) => x.title === e.title) }))
          .filter((x): x is { e: IndexedBook; c: CatalogEntry } => !!x.c)
        const unfinished = mine.filter((x) => !isPieceDone(prog[x.e.pieceId] ?? emptyProgress()))
        const from = unfinished.length ? unfinished : mine
        prevPick = from.sort((a, b) => rankOf(b.c) - rankOf(a.c))[0]?.c
      }
      if (!prevPick)
        notes.push(
          prevDate
            ? `${label}昨天（${prevDate}）那本不在选中的分组里，改按常规抽`
            : `${label}还没有更早的任务包，改按常规抽`,
        )
      else if (prevDate !== prevDay(date)) notes.push(`${label}「昨天」取的是 ${prevDate}`)
    }

    const byRankOlds = [...olds].sort(byRank)
    const easyOld = byRankOlds[0]
    const hardOld = byRankOlds[byRankOlds.length - 1]

    /**
     * 候选按优先级排好，**一本一本取、每取一本就看够没够两本**。
     * 早先是「先按方式抓两本，不够再整批补」，结果「2旧」只有 1 本旧书时
     * 一次补进 2 本新书 —— 那天变成 3 本。配额只能逐本给。
     * 前两项是家长选的方式，后面是兜底顺序。
     */
    const wish: [CatalogEntry | undefined, PlanPick['kind']][] =
      want === '昨天+新'
        ? [[prevPick, '昨天'], [news[0], '新书'], [pickOldest(olds), '旧书'], [news[1], '新书'], [easyOld, '旧书']]
        : want === '2新'
        ? [[news[0], '新书'], [news[1], '新书'], [pickOldest(olds), '旧书'], [easyOld, '旧书'], [hardOld, '旧书']]
        : want === '2旧'
          ? [[easyOld, '旧书'], [hardOld, '旧书'], [pickOldest(olds), '旧书'], [news[0], '新书'], [news[1], '新书']]
          : [[news[0], '新书'], [pickOldest(olds), '旧书'], [news[1], '新书'], [easyOld, '旧书'], [hardOld, '旧书']]

    let n = 0
    for (const [e, kind] of wish) {
      if (n >= 2) break
      if (take(e, kind)) n++
    }

    // 没按选的方式凑齐就说明一下 —— 家长看得见才不会以为是 bug
    const mine = picks.filter((k) => k.lang === lang)
    const wantNew = want === '2新' ? 2 : want === '2旧' ? 0 : 1 // 昨天+新 也是 1 本新书
    const gotNew = mine.filter((k) => k.kind === '新书').length
    if (mine.length < 2) notes.push(`${label}只凑出 ${mine.length} 本`)
    else if (gotNew !== wantNew)
      notes.push(`${label}「${want}」书不够，实际 ${gotNew} 新 ${2 - gotNew} 旧`)
  }

  // 组装 manifest：piece 直接复用源包里那一份，只把文件路径按新 id 重命名，
  // 指向同一批已存在的 blob
  const files: Record<string, Blob | string> = {}
  const pieces: PackPiece[] = []
  for (const [i, e] of chosen.entries()) {
    const raw = await loadPackMeta(e.slot)
    const src = raw?.manifest.pieces.find((pp) => pp.id === e.pieceId)
    if (!raw || !src) continue
    const id = `p${i + 1}`
    const ns = (path?: string | null): string | null => {
      if (!path) return null
      const ref = raw.files[path]
      if (ref === undefined) return null
      const np = `${id}/${path}`
      files[np] = ref // 可能是哈希（新包）也可能是 Blob（v1 老包），两种都原样搬
      return np
    }
    pieces.push({
      ...src,
      id,
      cover: ns(src.cover) ?? undefined,
      listen: { ...(src.listen ?? {}), audio: ns(src.listen?.audio) },
      pages: src.pages.map((pg) => ({ ...pg, image: ns(pg.image) ?? pg.image, audio: ns(pg.audio) })),
    })
  }

  const manifest: PackManifest = {
    format: 'reading-diary-pack',
    version: 1,
    date,
    note: '家长在 App 里生成的当日计划',
    pieces,
  }
  const all = new Set(await listPackDates())
  all.add(date)
  await setMany([
    [`pack:${date}`, { manifest, files } satisfies RawPack],
    ['dates', [...all].sort()],
  ])
  // 这里是自己写 pack 记录的（不走 savePack，因为素材全是现成的 blob，一个字节都不用新写），
  // 所以索引也得自己补一刀 —— 漏了虽然 loadBookIndex 会对账补回来，但那次书架要多读一个包
  await patchBookIndex(date, indexEntries({ manifest, files }))

  // 覆盖掉的旧包如果有独占素材，这里回收
  await gcBlobs()
  return { picks, empty, notes }
}

/** 家长上次勾选的分组，下次生成默认沿用 —— 免得每天重勾 */
export const loadGenGroups = async () => (await get<string[]>('genGroups')) ?? []
export const saveGenGroups = (g: string[]) => set('genGroups', g)

// ---- 设置 ----
const DEFAULT_SETTINGS: Settings = { pin: '123', childName: '' }

export const loadSettings = async (): Promise<Settings> => ({
  ...DEFAULT_SETTINGS,
  ...((await get<Partial<Settings>>('settings')) ?? {}),
})

export const saveSettings = (s: Settings) => set('settings', s)
