import { useCallback, useEffect, useRef, useState } from 'react'
import type { DayProgress } from './types'
import { emptyProgress, isPieceDone } from './types'
import {
  migrate,
  setMigrationStatus,
  loadDoneDates,
  markDayDone,
  loadPack,
  loadProgress,
  saveProgress,
  saveRecording,
  todayStr,
  type StoredPack,
} from './lib/db'
import { makeUrls } from './lib/pack'
import { runBackGuard } from './lib/back'
import Home from './pages/Home'
import Read from './pages/Read'
import Me from './pages/Me'
import Parent from './pages/Parent'
import Shelf from './pages/Shelf'
import Review from './pages/Review'

type View =
  | { name: 'home' }
  | { name: 'read'; pieceId: string }
  | { name: 'me' }
  | { name: 'parent' }
  | { name: 'shelf' }
  | { name: 'review'; date: string; pieceId: string }

export default function App() {
  const [date, setDate] = useState(todayStr)
  const [pack, setPack] = useState<StoredPack | null>(null)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [progress, setProgress] = useState<DayProgress>({})
  const [view, setView] = useState<View>({ name: 'home' })
  const [ready, setReady] = useState(false)
  const [doneDates, setDoneDates] = useState<string[]>([])

  // 首次加载：今天的任务包 + 进度 + 全部打卡日
  const reload = useCallback(async () => {
    // 升级后第一次打开可能要迁移数据。但迁移只是「省空间」的优化 ——
    // 读取层同时认新旧两种格式，所以它失败绝不能挡住启动。
    // 早先没有这个 try/catch：迁移一抛异常 ready 就永远不置 true，
    // App 卡在「载入中」，连家长页都进不去清理，彻底锁死。
    try {
      const r = await migrate()
      setMigrationStatus({ failed: r.failed, steps: r.steps })
    } catch {
      setMigrationStatus({ failed: ['*'], steps: ['迁移没跑起来'] })
    }
    const [p, prog, done] = await Promise.all([
      loadPack(date),
      loadProgress(date),
      loadDoneDates(),
    ])
    setPack(p ?? null)
    setProgress(prog)
    setDoneDates(done)
    setReady(true)
  }, [date])

  useEffect(() => {
    void reload()
  }, [reload])


  /**
   * 平板上 App 不会每天重启（孩子只是按 home 键切走），日期若只在挂载时
   * 取一次，第二天打开还会是昨天的任务包和昨天的奥特曼。每次回到前台
   * 都对一下日期。
   */
  useEffect(() => {
    const check = () => {
      const now = todayStr()
      setDate((d) => (d === now ? d : now))
    }
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    // 一直亮着屏摊在桌上跨过零点的情况，靠这个兜底
    const t = window.setInterval(check, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      clearInterval(t)
    }
  }, [])

  // 跨天了：回首页，别停在昨天的阅读页上
  useEffect(() => {
    setView({ name: 'home' })
  }, [date])

  /**
   * 安卓返回键。@capacitor/app 在纯网页里不会触发这个事件，所以动态
   * 引入、不进首屏包；APK 里才真正生效。
   */
  useEffect(() => {
    let alive = true
    let remove: (() => void) | undefined
    void (async () => {
      try {
        const { App: CapApp } = await import('@capacitor/app')
        const h = await CapApp.addListener('backButton', () => {
          if (runBackGuard()) return // 有没交的录音，阅读页自己弹确认
          if (view.name === 'home') void CapApp.minimizeApp()
          else if (view.name === 'review') setView({ name: 'shelf' })
          else setView({ name: 'home' })
        })
        // 视图切得快时 cleanup 会先跑完，这里必须补一刀，
        // 否则旧 listener 留在原生侧，返回键会按老视图的逻辑跳
        if (!alive) return void h.remove()
        remove = () => void h.remove()
      } catch {
        // 网页环境没有原生桥，忽略
      }
    })()
    return () => {
      alive = false
      remove?.()
    }
  }, [view.name])

  // 进阅读页前一次性建好全部 object URL，翻页就没有白屏等待
  useEffect(() => {
    if (!pack) {
      setUrls({})
      return
    }
    const { urls: u, revoke } = makeUrls(pack.files)
    setUrls(u)
    return revoke
  }, [pack])

  // 复习打开的是别的日期的包，单独载一份，不去动今天的 pack/urls
  const reviewDate = view.name === 'review' ? view.date : null
  const [reviewPack, setReviewPack] = useState<StoredPack | null>(null)
  const [reviewUrls, setReviewUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!reviewDate) {
      setReviewPack(null)
      setReviewUrls({})
      return
    }
    let revoke: (() => void) | undefined
    let alive = true
    void (async () => {
      const p = reviewDate === date ? pack : ((await loadPack(reviewDate)) ?? null)
      if (!alive || !p) return
      setReviewPack(p)
      const made = makeUrls(p.files)
      revoke = made.revoke
      setReviewUrls(made.urls)
    })()
    return () => {
      alive = false
      revoke?.()
    }
  }, [reviewDate, date, pack])

  // 进度的当前值。用 ref 是为了让 updateProgress 能在 setState 之外算出
  // next 并真正 await 落盘 —— 写在 setState 的 updater 里既不纯，
  // 调用方 await 也等不到 IndexedDB 写完
  const progressRef = useRef(progress)
  progressRef.current = progress
  // 同理：updateProgress 里要读当天的书目来判打卡章，用 ref 避免把 pack
  // 塞进依赖后每次换包都重建回调
  const packRef = useRef(pack)
  packRef.current = pack

  const updateProgress = useCallback(
    async (pieceId: string, patch: Partial<DayProgress[string]>) => {
      const prev = progressRef.current
      const next: DayProgress = {
        ...prev,
        [pieceId]: { ...(prev[pieceId] ?? emptyProgress()), ...patch },
      }
      progressRef.current = next
      setProgress(next)
      await saveProgress(date, next)

      // 打卡章集中在这里判，不挂在某个按钮上 —— 纯图绘本的录音是可选的，
      // 孩子可能根本不点录音，那条路上也得能盖章
      const pieces = packRef.current?.manifest.pieces
      if (pieces?.length && pieces.every((x) => isPieceDone(next[x.id] ?? emptyProgress(), x))) {
        await markDayDone(date)
        setDoneDates((d) => (d.includes(date) ? d : [...d, date]))
      }
      return next
    },
    [date],
  )


  if (!ready) return <div className="grid h-full place-items-center text-mute">载入中…</div>

  const home = () => setView({ name: 'home' })

  // 家长模式不需要先挑奥特曼，否则没任务包时家长进不来导入
  if (view.name === 'parent')
    return (
      <Parent
        date={date}
        manifest={pack?.manifest ?? null}
        onDataChanged={reload}
        onExit={home}
      />
    )


  if (view.name === 'me')
    return (
      <Me
        date={date}
        manifest={pack?.manifest ?? null}
        doneDates={doneDates}
        onExit={home}
      />
    )

  if (view.name === 'shelf')
    return (
      <Shelf
        today={date}
        onOpen={(d, pieceId) => setView({ name: 'review', date: d, pieceId })}
        onExit={home}
      />
    )

  if (view.name === 'review') {
    const piece = reviewPack?.manifest.pieces.find((p) => p.id === view.pieceId)
    if (!piece) return <div className="grid h-full place-items-center text-mute">载入中…</div>
    return <Review piece={piece} urls={reviewUrls} onExit={() => setView({ name: 'shelf' })} />
  }

  if (view.name === 'read' && pack) {
    const piece = pack.manifest.pieces.find((p) => p.id === view.pieceId)
    if (piece)
      return (
        <Read
          piece={piece}
          urls={urls}
          progress={progress[piece.id] ?? emptyProgress()}
          onProgress={(patch) => void updateProgress(piece.id, patch)}
          onSubmitRecording={async (blob) => {
            await saveRecording(date, piece.id, blob)
            await updateProgress(piece.id, { recorded: true })
          }}
          onExit={home}
        />
      )
  }

  return (
    <Home
      date={date}
      pack={pack}
      urls={urls}
      progress={progress}
      onOpenPiece={(pieceId) => setView({ name: 'read', pieceId })}
      onOpenMe={() => setView({ name: 'me' })}
      onOpenShelf={() => setView({ name: 'shelf' })}
      onOpenParent={() => setView({ name: 'parent' })}
    />
  )
}
