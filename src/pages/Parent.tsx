import { useEffect, useRef, useState } from 'react'
import type { PackManifest } from '../types'
import {
  cleanupGradedRecordings,
  recordingsFootprint,
  clearAllProgress,
  clearDay,
  loadProgress,
  loadRecording,
  loadSettings,
  loadStars,
  saveSettings,
  saveStars,
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
  const fileRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    void loadStars(date).then(setStars)
  }, [date])

  // 录音不自动清，所以把当前占用摆出来，家长自己判断要不要清
  const refreshFootprint = () => void recordingsFootprint().then(setFootprint)
  useEffect(refreshFootprint, [])

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
      let extra = ''

      // 同一天重新导入（改错、补页）时旧进度还在，孩子会被锁在
      // 「已完成」上读不到新版本 —— 问一下要不要一起清掉
      const prog = await loadProgress(m.date)
      if (Object.keys(prog).length) {
        if (
          window.confirm(
            `${m.date} 已经有阅读记录了。\n\n换了新的任务包，旧进度会让孩子看到「读完」印章、读不到新内容。\n\n要清掉这天的进度、星星和录音吗？`,
          )
        ) {
          await clearDay(m.date)
          if (m.date === date) {
            setStars({})
            setRecs({})
          }
          extra = '，并清掉了这天的旧进度'
        } else {
          extra = '（旧进度保留，孩子可能仍显示已读完）'
        }
      }

      setNotice(
        m.date === date
          ? `已导入 ${m.date} 的任务，共 ${m.pieces.length} 篇${extra}`
          : `已存好 ${m.date} 的任务，但今天是 ${date}，孩子端要到那天才看得到${extra}`,
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

        <button
          onClick={() => fileRef.current?.click()}
          className="w-full rounded-xl border border-dashed border-[#cfc7bb] bg-white py-3 text-[12px] text-mute"
        >
          ＋ 导入任务包（.rdpkg）
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
