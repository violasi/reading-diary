import { useEffect, useRef, useState } from 'react'
import type { PackManifest } from '../types'
import {
  cleanupGradedRecordings,
  generateDayPlan,
  getMigrationStatus,
  listGroups,
  loadGenGroups,
  recordingsFootprint,
  saveGenGroups,
  clearAllProgress,
  clearDay,
  loadProgress,
  loadRecording,
  loadSettings,
  loadStars,
  saveSettings,
  saveStars,
  type GroupStat,
} from '../lib/db'
import { PackError, importPack } from '../lib/pack'
import { Star } from '../components/Icons'

/** 家长模式：成人界面，不要卡通。PIN 默认 123 */
export default function Parent({
  date,
  manifest,
  onDataChanged,
  onExit,
}: {
  date: string
  manifest: PackManifest | null
  onDataChanged: () => void
  onExit: () => void
}) {
  const [pin, setPin] = useState('')
  const [ok, setOk] = useState(false)
  // 初始必须是 null，不能是 '123'：设置是异步读出来的，若先摆一个默认值，
  // 在读完之前输 123 就能进 —— 改过密码的家庭等于有个后门
  const [realPin, setRealPin] = useState<string | null>(null)
  const [wrong, setWrong] = useState(false)

  useEffect(() => {
    void loadSettings().then((s) => setRealPin(s.pin))
  }, [])

  const submit = (v: string) => {
    if (realPin === null) return // 还没读到密码，一律不放行
    if (v === realPin) setOk(true)
    else {
      setWrong(true)
      setPin('')
      setTimeout(() => setWrong(false), 1200)
    }
  }

  if (!ok)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 bg-[#3b3630] px-8 text-white">
        <p className="text-sm opacity-80">{realPin === null ? '正在打开…' : '请输入家长密码'}</p>
        <div className="flex gap-2.5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span
              key={i}
              className={`h-3 w-3 rounded-full ${i < pin.length ? 'bg-white' : 'bg-white/25'}`}
            />
          ))}
        </div>
        {wrong && <p className="text-sm text-[#ff8a8a]">密码不对</p>}
        <div className="grid w-full max-w-[260px] grid-cols-3 gap-2.5">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) => (
            <button
              key={i}
              disabled={!k || realPin === null}
              onClick={() => {
                if (k === '⌫') return setPin((p) => p.slice(0, -1))
                const v = (pin + k).slice(0, 6)
                setPin(v)
                if (realPin !== null && v.length >= realPin.length) submit(v)
              }}
              className={`tap rounded-xl text-xl font-bold ${
                k ? 'bg-white/12 active:bg-white/25' : 'opacity-0'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <button onClick={onExit} className="tap mt-2 text-sm opacity-70 underline">
          返回
        </button>
      </div>
    )

  // ok 只可能在密码读出来之后被置 true，所以这里 realPin 一定不是 null
  if (realPin === null) return null

  return (
    <ParentPanel
      date={date}
      manifest={manifest}
      onDataChanged={onDataChanged}
      onExit={onExit}
      pin={realPin}
      onPinChange={async (p) => {
        const s = await loadSettings()
        await saveSettings({ ...s, pin: p })
        setRealPin(p)
      }}
    />
  )
}

function ParentPanel({
  date,
  manifest,
  onDataChanged,
  onExit,
  pin,
  onPinChange,
}: {
  date: string
  manifest: PackManifest | null
  onDataChanged: () => void
  onExit: () => void
  pin: string
  onPinChange: (p: string) => Promise<void>
}) {
  const [stars, setStars] = useState<Record<string, number>>({})
  const [recs, setRecs] = useState<Record<string, Blob>>({})
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [footprint, setFootprint] = useState<{ count: number; bytes: number } | null>(null)
  // 生成当日计划：家长勾选从哪些分组抽书（RAZ B 太简单就别勾）
  const [groups, setGroups] = useState<GroupStat[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    void loadStars(date).then(setStars)
  }, [date])

  // 录音不自动清，所以把当前占用摆出来，家长自己判断要不要清
  const refreshFootprint = () => void recordingsFootprint().then(setFootprint)
  useEffect(refreshFootprint, [])

  const refreshGroups = async () => setGroups(await listGroups())
  useEffect(() => {
    void refreshGroups()
    void loadGenGroups().then(setPicked)
  }, [])

  const toggleGroup = (g: string) => {
    const next = picked.includes(g) ? picked.filter((x) => x !== g) : [...picked, g]
    setPicked(next)
    void saveGenGroups(next)
  }

  /**
   * 生成今天的计划。中英文各一本新书 + 一本旧书，只从勾上的分组里抽。
   *
   * 今天已经有进度时必须先清 —— 生成出来的 piece id 是重编的（p1…p4），
   * 直接覆盖会让旧进度串到别的书上（孩子会看到没读过的书顶着「读完」印章）。
   */
  const generate = async () => {
    setErr(null)
    setNotice(null)
    if (!picked.length) return setErr('先勾选至少一个分组')
    const prog = await loadProgress(date)
    if (Object.keys(prog).length) {
      if (
        !window.confirm(
          `${date} 已经有阅读记录了。\n\n重新生成会换掉今天的书，旧进度会对不上（孩子可能看到没读过的书显示「读完」）。\n\n要清掉今天的进度、星星和录音再生成吗？`,
        )
      )
        return
      await clearDay(date)
      setStars({})
      setRecs({})
    }
    setGenerating(true)
    try {
      const { picks, empty } = await generateDayPlan(date, picked)
      if (!picks.length) {
        setErr('勾选的分组里一本书都没有')
        return
      }
      const line = picks.map((k) => `${k.kind === '新书' ? '新' : '旧'}·${k.title}`).join('，')
      setNotice(
        `已生成 ${date} 的计划：${line}` +
          (empty.length ? `（${empty.join('、')}没有可选的书，跳过了）` : ''),
      )
      await refreshGroups()
      onDataChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  useEffect(() => {
    if (!manifest) return
    void (async () => {
      const out: Record<string, Blob> = {}
      for (const p of manifest.pieces) {
        const b = await loadRecording(date, p.id)
        if (b) out[p.id] = b
      }
      setRecs(out)
    })()
  }, [manifest, date])

  // 离开时收拾掉播放器和 object URL
  useEffect(
    () => () => {
      audioRef.current?.pause()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    [],
  )

  const play = (blob: Blob) => {
    if (!audioRef.current) audioRef.current = new Audio()
    const a = audioRef.current
    a.pause()
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = URL.createObjectURL(blob)
    a.src = urlRef.current
    void a.play().catch(() => setErr('这段录音播不出来'))
  }

  const rate = async (pieceId: string, n: number) => {
    const next = { ...stars, [pieceId]: n }
    setStars(next)
    await saveStars(date, next) // 点星即存，没有「提交」按钮
  }

  const pick = async (f: File | undefined) => {
    if (!f) return
    setErr(null)
    setNotice(null)
    try {
      const m = await importPack(f)

      // 系列包：一整套书入库，不绑定任何一天。没有进度要处理，直接进书架
      if (m.series) {
        setNotice(`已入库系列《${m.series}》，共 ${m.pieces.length} 本。可以在下面「生成今天的计划」里勾选`)
        await refreshGroups()
        onDataChanged()
        return
      }

      let extra = ''
      const day = m.date!

      // 同一天重新导入（改错、补页）时旧进度还在，孩子会被锁在
      // 「已完成」上读不到新版本 —— 问一下要不要一起清掉
      const prog = await loadProgress(day)
      if (Object.keys(prog).length) {
        if (
          window.confirm(
            `${day} 已经有阅读记录了。\n\n换了新的任务包，旧进度会让孩子看到「读完」印章、读不到新内容。\n\n要清掉这天的进度、星星和录音吗？`,
          )
        ) {
          await clearDay(day)
          if (day === date) {
            setStars({})
            setRecs({})
          }
          extra = '，并清掉了这天的旧进度'
        } else {
          extra = '（旧进度保留，孩子可能仍显示已读完）'
        }
      }

      setNotice(
        day === date
          ? `已导入 ${day} 的任务，共 ${m.pieces.length} 篇${extra}`
          : `已存好 ${day} 的任务，但今天是 ${date}，孩子端要到那天才看得到${extra}`,
      )
      onDataChanged()
    } catch (e) {
      setErr(e instanceof PackError ? e.message : '导入失败')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  /** 清今天：家长自己试玩过、要让孩子从干净的今天开始 */
  const resetToday = async () => {
    if (
      !window.confirm(
        `清空 ${date} 的记录？\n\n这天的进度、星星、录音都会删掉，孩子今天可以重新读一遍。\n书和以前的打卡都不动。`,
      )
    )
      return
    await clearDay(date)
    setStars({})
    setRecs({})
    setNotice(`已清空 ${date} 的记录`)
    onDataChanged()
  }

  /** 全部清零：交给孩子之前抹掉试玩痕迹。要打字确认，误触代价太大 */
  const resetAll = async () => {
    const v = window.prompt(
      '清空全部打卡记录？\n\n所有日期的进度、星星、录音都会删掉，打卡日历会变空。\n书和书架不受影响 —— 导入过的书都还在，孩子照样能读、能复习。\n\n确认请输入：清空',
    )
    if (v === null) return
    if (v.trim() !== '清空') return setErr('没有清空（要输入「清空」两个字）')
    const n = await clearAllProgress()
    setStars({})
    setRecs({})
    setNotice(`已清零，删掉 ${n} 条记录。书都还在，孩子可以重新读`)
    onDataChanged()
  }

  const cleanRecs = async () => {
    const { count, freed } = await cleanupGradedRecordings(date)
    refreshFootprint()
    setNotice(
      count
        ? `清掉 ${count} 段已评分的旧录音，腾出 ${humanSize(freed)}`
        : '没有可清的：往日录音要么已经清过，要么还没评分',
    )
  }


  const changePin = async () => {
    const p = window.prompt(`当前密码 ${pin}，输入新的数字密码：`, pin)
    if (p && /^\d{1,6}$/.test(p)) await onPinChange(p)
    else if (p !== null) setErr('密码要是 1~6 位数字')
  }

  return (
    <div className="flex h-full flex-col bg-[#fbfaf8]">
      <header className="flex items-center justify-between bg-[#3b3630] px-4 py-3 text-white">
        <span className="text-sm font-bold">今日录音 · {date}</span>
        <button onClick={onExit} className="text-sm opacity-80 underline">
          返回
        </button>
      </header>

      <main className="flex-1 space-y-2.5 overflow-y-auto p-3">
        {/* 迁移是「尽力而为」，失败不挡启动 —— 但必须让家长看得到，
            否则空间没省下来、也没人知道为什么 */}
        {!!getMigrationStatus()?.failed.length && (
          <p className="rounded-xl bg-sun/15 p-2.5 text-[12px] text-[#7a5b12]">
            有 {getMigrationStatus()!.failed.length} 个任务包没能整理成省空间的格式
            （常见原因是平板存储空间不足）。App 照常能用，腾出空间后下次打开会自动重试。
          </p>
        )}
        {!manifest && <p className="py-8 text-center text-sm text-mute">今天还没有任务包</p>}

        {manifest?.pieces.map((p) => {
          const blob = recs[p.id]
          return (
            <div key={p.id} className="rounded-xl border border-[#eae5dd] bg-white p-3">
              <div className="text-[13px] font-bold">{p.title}</div>
              <div className="mt-0.5 text-[11px] text-mute">
                {p.pages.length} 页
                {blob ? ` · ${(blob.size / 1024).toFixed(0)} KB` : ' · 还没交录音'}
              </div>
              <div className="mt-2.5 flex items-center gap-3">
                <button
                  disabled={!blob}
                  onClick={() => blob && play(blob)}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-water text-sm text-white disabled:bg-[#ddd6ca]"
                  aria-label="播放"
                >
                  ▶
                </button>
                <div className="flex gap-0.5">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => void rate(p.id, n)}
                      aria-label={`${n} 星`}
                      className="p-1"
                    >
                      <Star
                        className={`h-6 w-6 ${
                          n <= (stars[p.id] ?? 0) ? 'text-sun' : 'text-[#ddd6ca]'
                        }`}
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )
        })}

        {/* 生成当日计划：中英文各一本新书 + 一本旧书，只从勾上的分组里抽。
            分组粒度是「系列或分级」—— 孩子觉得 RAZ B 太简单，不勾它就行 */}
        <section className="mt-4 rounded-xl border border-[#eae5dd] bg-white p-3">
          <h3 className="text-[11px] font-bold tracking-wide text-mute">生成今天的计划</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-mute">
            中文、英文各抽一本新书 + 一本旧书。新书挑没读过的里面最简单的，
            旧书从最久没读的里面随机。某一边没有新书了，就抽两本旧书（一易一难）。
          </p>

          {groups === null && <p className="mt-2 text-[11px] text-mute">读取书库中…</p>}
          {groups?.length === 0 && (
            <p className="mt-2 text-[11px] text-mute">书库还是空的，先导入任务包或系列包</p>
          )}

          {(['zh', 'en'] as const).map((lang) => {
            const list = groups?.filter((g) => g.lang === lang) ?? []
            if (!list.length) return null
            return (
              <div key={lang} className="mt-2.5">
                <div className="text-[11px] font-bold text-[#7d7467]">
                  {lang === 'zh' ? '中文' : '英文'}
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {list.map((g) => {
                    const on = picked.includes(g.group)
                    return (
                      <button
                        key={g.group}
                        onClick={() => toggleGroup(g.group)}
                        className={`rounded-lg border px-2 py-1 text-left text-[11px] leading-tight ${
                          on
                            ? 'border-water bg-water/10 text-[#1f6f96]'
                            : 'border-[#e4ded4] bg-white text-mute'
                        }`}
                      >
                        <span className="font-bold">{on ? '✓ ' : ''}{g.group}</span>
                        <span className="ml-1 opacity-70">
                          {g.total} 本 · 新 {g.unread}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          <button
            disabled={generating || !picked.length}
            onClick={() => void generate()}
            className="tap mt-3 w-full rounded-xl bg-water py-2.5 text-[13px] font-bold text-white disabled:bg-[#ddd6ca]"
          >
            {generating ? '生成中…' : `生成 ${date} 的计划`}
          </button>
        </section>

        <button
          onClick={() => fileRef.current?.click()}
          className="w-full rounded-xl border border-dashed border-[#cfc7bb] bg-white py-3 text-[12px] text-mute"
        >
          ＋ 导入 .rdpkg（当日任务包 或 整套系列）
        </button>
        {/* accept 不能只写 .rdpkg：安卓的文档选择器按 MIME 过滤，未知扩展名
            没有对应 MIME，文件会被灰掉、根本选不中。放开成任意类型，选错了
            由 importPack 校验后明确报错 —— 这比在平板上选不中文件好得多 */}
        <input
          ref={fileRef}
          type="file"
          accept="*/*"
          className="hidden"
          onChange={(e) => void pick(e.target.files?.[0])}
        />

        {/* 维护区。清零放在最下面、样式压得很淡，避免家长评分时误触 */}
        <section className="mt-4 rounded-xl border border-[#eae5dd] bg-white p-3">
          <h3 className="text-[11px] font-bold tracking-wide text-mute">维护</h3>
          <div className="mt-2 space-y-1.5">
            <MaintRow
              label="清理已评分的旧录音"
              hint={
                footprint
                  ? `现在存着 ${footprint.count} 段、共 ${humanSize(footprint.bytes)}。只清往日已评分的，今天的不动`
                  : '只清往日已评分的，今天的不动'
              }
              onClick={() => void cleanRecs()}
            />
            <MaintRow
              label={`清空今天（${date}）的记录`}
              hint="自己试玩过、想让孩子从干净的今天开始"
              danger
              onClick={() => void resetToday()}
            />
            <MaintRow
              label="清空全部打卡记录"
              hint="抹掉全部试玩痕迹，日历变空。书和书架都不受影响"
              danger
              onClick={() => void resetAll()}
            />
          </div>
        </section>

        {err && <p className="rounded-xl bg-ultra/10 p-2.5 text-center text-[12.5px] text-ultra">{err}</p>}
        {notice && (
          <p className="rounded-xl bg-water/10 p-2.5 text-center text-[12.5px] text-water">{notice}</p>
        )}
      </main>

      <footer className="space-y-1 border-t border-[#eee7dc] p-3 text-[11px] text-mute">
        <p>点星即存，没有「提交」按钮。录音不会自动删，占地方了到上面「维护」里清。</p>
        <button onClick={() => void changePin()} className="underline">
          改密码（当前 {pin}）
        </button>
      </footer>
    </div>
  )
}

/** 几十 KB 别显示成「0.0 MB」，家长会以为没清掉 */
const humanSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`

function MaintRow({
  label,
  hint,
  danger,
  onClick,
}: {
  label: string
  hint: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="tap w-full rounded-lg bg-[#faf8f5] px-2.5 py-2 text-left active:bg-[#f1ece3]"
    >
      <div className={`text-[12.5px] font-bold ${danger ? 'text-ultra' : 'text-[#4a443c]'}`}>
        {label}
      </div>
      <div className="text-[10.5px] text-mute">{hint}</div>
    </button>
  )
}
