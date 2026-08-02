import { useEffect, useMemo, useRef, useState } from 'react'
import type { PackPiece, PieceProgress, Stage } from '../types'
import { modeOf, stageOf } from '../types'
import HeroImg from '../components/HeroImg'
import { Bolt, Butterfly, Fish, Play } from '../components/Icons'
import { useRecorder } from '../lib/recorder'
import { setBackGuard } from '../lib/back'
import { useSwipe } from '../lib/swipe'

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

interface Props {
  piece: PackPiece
  urls: Record<string, string>
  progress: PieceProgress
  onProgress: (patch: Partial<PieceProgress>) => void
  onSubmitRecording: (blob: Blob) => Promise<void>
  onExit: () => void
}

export default function Read({
  piece,
  urls,
  progress,
  onProgress,
  onSubmitRecording,
  onExit,
}: Props) {
  // 第一关按顺序播全篇时，显示的是正在播的那一页
  const [listenIdx, setListenIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [justCaught, setJustCaught] = useState(false)

  // listened 一置 true，stageOf 就会跳到第二关。但设计要求听完先停在
  // 「再听一遍 / 去跟读」那一屏，所以用这个本地状态把第一关按住，
  // 直到孩子自己点「去跟读」。
  const [holdStage1, setHoldStage1] = useState(false)
  const mode = modeOf(piece)
  const stage: Stage = holdStage1 ? 1 : stageOf(progress, piece)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!audioRef.current) audioRef.current = new Audio()

  // 孩子自己翻页时看的那一页：第三关边翻边读用，纯图绘本的自由浏览也用
  const [turnIdx, setTurnIdx] = useState(0)
  const rec = useRecorder()
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [transformed, setTransformed] = useState(false)
  // 绘本可以不录音就完成，变身屏别硬说「录音已经交给爸爸妈妈」
  const [gaveRec, setGaveRec] = useState(false)

  /**
   * 「回去再跟读」。孩子到了录音关常常发现自己还是读不出来，得能退回去练。
   *
   * 刻意**不动已有进度**：不把 pagesRead 清零，所以练完随时能回来录，
   * 不用把整本重新点一遍。练习时页码自己管（practiceIdx），
   * 和正式关 2 那个由 pagesRead 推出来的页码互不干扰。
   */
  const [practicing, setPracticing] = useState(false)
  const [practiceIdx, setPracticeIdx] = useState(0)

  // 第二关停在还没读完的那一页
  const readIdx = Math.min(progress.pagesRead, piece.pages.length - 1)
  // 关 2 当前看哪一页：练习模式下自己翻，正式跟读时停在还没读完的那一页
  const followIdx = practicing ? practiceIdx : readIdx
  const shownIdx =
    practicing
      ? followIdx
      : mode === 'browse'
        ? turnIdx
        : stage === 1
          ? listenIdx
          : stage === 3
            ? turnIdx
            : readIdx
  const shownPage = piece.pages[shownIdx]

  /**
   * 播放代号。speechSynthesis.cancel() 之后被取消的那条 utterance 仍可能
   * 触发 onend —— 第一关的 onDone 是「翻到下一页并继续播」，孩子点了停止
   * 却还在自动翻页、还在记进度。换一个代号就让在飞的回调全部作废。
   */
  const genRef = useRef(0)

  /**
   * 试听刚录的那段。必须握在 ref 里 —— 之前是每次现造一个游离的 Audio，
   * 谁都停不住它：孩子点了试听马上返回，那段录音会在首页继续响到播完。
   */
  const previewRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null)

  const stopPreview = () => {
    const p = previewRef.current
    if (!p) return
    previewRef.current = null
    p.audio.onended = null
    p.audio.onerror = null
    p.audio.pause()
    URL.revokeObjectURL(p.url) // 不 revoke 的话每次试听漏一个
  }

  const playPreview = (blob: Blob) => {
    stopPreview() // 连点两次不要叠着放
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    previewRef.current = { audio, url }
    audio.onended = stopPreview
    audio.onerror = stopPreview
    void audio.play().catch(stopPreview)
  }

  // 离开时一定要停掉音频和朗读，否则会在后台继续响
  useEffect(() => {
    const a = audioRef.current!
    return () => {
      // 卸载同样要作废回调：孩子在「听故事」时按实体返回键就走这条路，
      // 而 a.src = '' 在部分浏览器本身会触发一次 error 事件 —— 不作废的话
      // 那次 error 会把 step() 再往下推一页，人都走了还在记进度
      genRef.current++
      a.onended = null
      a.onerror = null
      a.pause()
      a.src = ''
      window.speechSynthesis?.cancel()
      stopPreview()
    }
  }, [])

  const speak = (text: string, onDone: () => void) => {
    const synth = window.speechSynthesis
    if (!synth) return onDone()
    synth.cancel()
    const gen = genRef.current
    const guarded = () => {
      if (gen === genRef.current) onDone()
    }
    const u = new SpeechSynthesisUtterance(text)
    u.lang = piece.lang || 'en-US'
    u.rate = 0.8
    u.onend = guarded
    u.onerror = guarded
    synth.speak(u)
  }

  /** 播一页：有真人音就放，没有就用 TTS 念 text */
  const playPage = (idx: number, onDone: () => void) => {
    const page = piece.pages[idx]
    if (!page) return onDone()
    const a = audioRef.current!
    const src = page.audio ? urls[page.audio] : undefined
    const gen = genRef.current
    const guarded = () => {
      if (gen === genRef.current) onDone()
    }
    if (src) {
      a.pause()
      a.src = src
      a.onended = guarded
      a.onerror = guarded
      void a.play().catch(guarded)
    } else if (page.text) {
      speak(page.text, onDone)
    } else {
      onDone()
    }
  }

  const stopAll = () => {
    genRef.current++ // 作废所有在飞的回调
    audioRef.current!.pause()
    window.speechSynthesis?.cancel()
    stopPreview()
    setPlaying(false)
  }

  // ---- 第一关：顺序播完全篇 ----
  const startListen = () => {
    setPlaying(true)
    setJustCaught(false)
    const step = (i: number) => {
      if (i >= piece.pages.length) {
        setPlaying(false)
        setJustCaught(true)
        setHoldStage1(true) // 停在「再听一遍 / 去跟读」这一屏
        onProgress({ listened: true })
        return
      }
      setListenIdx(i)
      playPage(i, () => step(i + 1))
    }
    step(0)
  }

  // ---- 第二关：听这一页 ----
  const [pagePlaying, setPagePlaying] = useState(false)

  const playThisPage = (idx = followIdx) => {
    setPagePlaying(true)
    playPage(idx, () => setPagePlaying(false))
  }

  const finishThisPage = () => {
    stopAll()
    setPagePlaying(false)
    if (practicing) {
      // 练习：只是翻到下一页，翻到底就自动结束练习回到录音
      if (practiceIdx >= piece.pages.length - 1) setPracticing(false)
      else setPracticeIdx((i) => i + 1)
      return
    }
    onProgress({ pagesRead: progress.pagesRead + 1 })
  }

  /**
   * 有还没落盘的录音。两种情况都算：
   *   - 正在录
   *   - 录完了但还没点「交给爸爸妈妈」—— 这段 blob 只在组件内存里，
   *     退出这一页就真的没了，孩子得从头再读一遍
   *
   * gaveRec 必须参与判断：交成功后 blob 仍留在内存里，不排掉的话
   * 变身成功屏上按实体返回键会冤枉地弹「录音还没交」。
   */
  const unsaved =
    !gaveRec && (rec.state === 'recording' || (rec.state === 'done' && !!rec.blob))

  // 底部区块：显式布尔，比嵌三元好读
  const showListen = mode === 'listen' && stage === 1 && !practicing
  // 练习模式借用关 2 的界面（听这页 + 我读好了）
  const showFollow = mode === 'listen' && (stage === 2 || practicing)
  const showBrowse = mode === 'browse' && stage === 1 && !practicing
  const showRecord = (mode === 'browse' ? stage === 2 : stage === 3) && !practicing
  const lastPage = piece.pages.length - 1

  /**
   * 关 2 翻到新的一页就自动念一遍 —— 孩子本来要先点一下「听这页」才出声，
   * 多这一步既是负担，也容易让他干等着不知道要干嘛。
   *
   * 用 ref 记住「上一次自动念的是哪一页」来去重：不然每次重渲染都会重新触发，
   * 把孩子自己点的「听这页」打断。「听这页」按钮保留，用来反复听。
   *
   * 自动播放不会被浏览器拦：进关 2 和翻页都是孩子点出来的，
   * 页面已经有用户手势激活。
   */
  const autoPlayedRef = useRef<number | null>(null)
  useEffect(() => {
    if (!showFollow) {
      autoPlayedRef.current = null
      return
    }
    if (autoPlayedRef.current === followIdx) return
    autoPlayedRef.current = followIdx
    playThisPage(followIdx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFollow, followIdx])


  // 翻页统一走这里：箭头和滑动共用，边界自己夹住
  const turnTo = (i: number) => setTurnIdx(Math.max(0, Math.min(lastPage, i)))
  const canTurn = mode === 'browse' || stage === 3
  const swipe = useSwipe(() => turnTo(turnIdx - 1), () => turnTo(turnIdx + 1))

  const handleBack = () => {
    if (rec.state === 'recording' && !window.confirm('正在录音，真的要离开吗？')) return
    if (
      rec.state === 'done' &&
      rec.blob &&
      !window.confirm('这段录音还没交给爸爸妈妈，离开就没有了。真的要走吗？')
    )
      return
    stopAll()
    onExit()
  }

  // 安卓实体返回键走的是另一条路，得单独拦，否则一按就退出、录音全丢
  const backRef = useRef(handleBack)
  backRef.current = handleBack
  useEffect(() => {
    if (!unsaved) return
    setBackGuard(() => {
      backRef.current()
      return true
    })
    return () => setBackGuard(null)
  }, [unsaved])

  // 交完录音 → 奥特曼变身。盖满全屏，否则底部操作条会露在浮层外面
  if (transformed)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-deep px-6 text-center text-white">
        <HeroImg className="h-40 w-40 animate-pulse object-contain drop-shadow-[0_0_30px_rgba(255,138,138,.85)]" />
        <h2 className="text-xl font-extrabold">《{piece.title}》读完啦！</h2>
        <p className="text-[13px] opacity-90">
          {gaveRec ? '录音已经交给爸爸妈妈' : '今天的书看完啦'}
        </p>
        <button
          onClick={onExit}
          className="tap mt-3 rounded-2xl bg-white px-10 py-3 text-[15px] font-bold text-deep"
        >
          好
        </button>
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      <StageBar stage={stage} total={mode === 'browse' ? 2 : 3} onBack={handleBack} />

      {/* 中部：整页原图。min-h-0 是关键 —— 否则 flex 子项按内容撑开，
          底部那行字会被裁掉，而那行字正是孩子要读的内容 */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-2.5"
        {...(canTurn ? swipe : {})}
      >
        {shownPage && urls[shownPage.image] ? (
          <img
            src={urls[shownPage.image]}
            alt=""
            className="max-h-full max-w-full rounded-lg object-contain shadow-md"
          />
        ) : (
          <p className="text-mute">这一页的图片丢了</p>
        )}
        {showListen && (playing || justCaught) && (
          <Butterfly
            className={`absolute top-3 right-5 h-8 w-8 text-sun ${
              playing ? 'animate-bounce' : ''
            }`}
          />
        )}

        {/* 孩子自己翻页：第三关边翻边读，纯图绘本全程都能翻 */}
        {(mode === 'browse' || stage === 3) && (
          <>
            <PageArrow side="left" disabled={turnIdx === 0} onClick={() => turnTo(turnIdx - 1)} />
            <PageArrow
              side="right"
              disabled={turnIdx >= lastPage}
              onClick={() => turnTo(turnIdx + 1)}
            />
            <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-0.5 text-[11px] font-bold text-white">
              {turnIdx + 1} / {piece.pages.length}
            </span>
          </>
        )}

      </div>

      {/* 底部：唯一随关卡变化的区域 */}
      <div className="border-t border-[#eee7dc] bg-white p-3">
        {showListen && (
          <>
            {playing ? (
              <button onClick={stopAll} className="tap w-full rounded-2xl bg-sun/70 py-4 text-lg font-extrabold text-white">
                正在听… 第 {listenIdx + 1} / {piece.pages.length} 页
              </button>
            ) : progress.listened ? (
              <div className="flex gap-2.5">
                <button
                  onClick={startListen}
                  className="tap flex-1 rounded-2xl bg-[#f1ece3] py-3.5 text-[15px] font-bold text-[#6f665a]"
                >
                  再听一遍
                </button>
                <button
                  onClick={() => {
                    stopAll()
                    setHoldStage1(false)
                  }}
                  className="tap flex-1 rounded-2xl bg-water py-3.5 text-[15px] font-bold text-white"
                >
                  去跟读 →
                </button>
              </div>
            ) : (
              <button
                onClick={startListen}
                className="tap flex w-full items-center justify-center gap-2.5 rounded-2xl bg-sun py-4 text-xl font-extrabold text-white active:bg-sun/85"
              >
                <Play className="h-5 w-5" /> 听故事
              </button>
            )}
            <p className="mt-2 text-center text-[11.5px] text-mute">
              {playing ? '播放中会自动翻页' : progress.listened ? '听过啦，可以去跟读了' : '先完整听一遍'}
            </p>
          </>
        )}

        {showFollow && (
          <>
            <div className="flex gap-2.5">
              <button
                onClick={() => playThisPage()}
                className="tap flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[#f1ece3] py-3.5 text-[15px] font-bold text-[#6f665a] active:bg-[#e7e0d4]"
              >
                <Play className="h-4 w-4" />
                {pagePlaying ? '在念…' : '听这页'}
              </button>
              <button
                onClick={finishThisPage}
                className="tap flex-1 rounded-2xl bg-water py-3.5 text-[15px] font-bold text-white active:bg-water/85"
              >
                我读好了 →
              </button>
            </div>
            {practicing ? (
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11.5px] text-mute">
                  再练一练 · 第 {practiceIdx + 1} / {piece.pages.length} 页
                </span>
                <button
                  onClick={() => {
                    stopAll()
                    setPagePlaying(false)
                    setPracticing(false)
                  }}
                  className="tap rounded-xl bg-ultra/10 px-3 py-1.5 text-[12.5px] font-bold text-ultra"
                >
                  练好了，去录音 →
                </button>
              </div>
            ) : (
              <FishTank total={piece.pages.length} filled={progress.pagesRead} />
            )}
          </>
        )}

        {/* 纯图绘本第一步：自由浏览。大人念、孩子翻。
            「看完啦」只在最后一页出现 —— 实际用起来孩子会在翻页时误触它，
            一按就跳去录音、这本书当场算看完了。放到末页等于用「翻到底」
            代替确认，既防误触，也不用孩子瞄准任何小按钮。 */}
        {showBrowse && (
          <>
            {turnIdx >= lastPage ? (
              <button
                onClick={() => onProgress({ browsed: true })}
                className="tap w-full rounded-2xl bg-sun py-4 text-xl font-extrabold text-white active:bg-sun/85"
              >
                看完啦 →
              </button>
            ) : (
              <p className="py-2 text-center text-[13px] font-bold text-[#6f665a]">
                和爸爸妈妈一起看 · 左右滑动翻页
                <span className="ml-1.5 font-normal text-mute">
                  第 {turnIdx + 1} / {piece.pages.length} 页
                </span>
              </p>
            )}
          </>
        )}

        {/* 到了录音关才发现读不出来是常事，给一条退路。
            练习不动已有进度，所以练完能直接回来录，不用整本重点一遍 */}
        {showRecord && mode === 'listen' && rec.state === 'idle' && !gaveRec && (
          <button
            onClick={() => {
              stopAll()
              setPracticeIdx(0)
              setPracticing(true)
            }}
            className="tap mb-2 w-full rounded-xl bg-[#f1ece3] py-2.5 text-[13px] font-bold text-[#6f665a] active:bg-[#e7e0d4]"
          >
            还不太会读？回去再跟读几遍
          </button>
        )}

        {showRecord && (
          <>
            {rec.state === 'idle' && !rec.blob && (
              <>
                <button
                  onClick={rec.start}
                  className="tap flex w-full items-center justify-center gap-2.5 rounded-2xl bg-ultra py-4 text-xl font-extrabold text-white active:bg-ultra/85"
                >
                  <span className="text-2xl leading-none">●</span>
                  {mode === 'browse' ? '录一段给爸爸妈妈' : '开始录音'}
                </button>
                {/* 绘本的录音是可选的：不想录也该有路走完，不然孩子卡在这一屏 */}
                {mode === 'browse' && (
                  <button
                    onClick={() => setTransformed(true)}
                    className="tap mt-2 w-full rounded-2xl bg-[#f1ece3] py-3 text-[14px] font-bold text-[#6f665a]"
                  >
                    不录了，今天读完啦 ✓
                  </button>
                )}
              </>
            )}

            {rec.state === 'recording' && (
              <>
                <button
                  onClick={rec.stop}
                  className="tap flex w-full items-center justify-center gap-2.5 rounded-2xl bg-ultra py-4 text-xl font-extrabold text-white"
                >
                  <span className="text-lg leading-none">■</span> 读完了
                  <span className="text-sm font-bold opacity-80">{fmt(rec.seconds)}</span>
                </button>
                <EnergyBar level={rec.level} />
              </>
            )}

            {rec.state === 'done' && rec.blob && (
              <>
                <button
                  onClick={() => playPreview(rec.blob!)}
                  className="tap flex w-full items-center justify-center gap-2 rounded-2xl bg-[#f1ece3] py-3.5 text-[15px] font-bold text-[#6f665a] active:bg-[#e7e0d4]"
                >
                  <Play className="h-4 w-4" /> 听听我读的（{fmt(rec.seconds)}）
                </button>
                <div className="mt-2.5 flex gap-2.5">
                  <button
                    onClick={() => {
                      stopPreview()
                      rec.reset()
                    }}
                    className="tap flex-1 rounded-2xl bg-[#f1ece3] py-3.5 text-[15px] font-bold text-[#6f665a]"
                  >
                    重录
                  </button>
                  <button
                    disabled={submitting}
                    onClick={async () => {
                      setSubmitting(true)
                      setSubmitError(null)
                      try {
                        await onSubmitRecording(rec.blob!)
                        setGaveRec(true)
                        setTransformed(true)
                      } catch {
                        // 存不进去最常见的原因是存储空间满了。blob 还在内存里，
                        // 所以不清 rec —— 让孩子能原地再点一次，不用重读一遍
                        setSubmitError('没交上，再试一次？')
                      } finally {
                        setSubmitting(false)
                      }
                    }}
                    className="tap flex-1 rounded-2xl bg-[#3fae63] py-3.5 text-[15px] font-bold text-white disabled:opacity-60"
                  >
                    {submitting ? '交给爸爸妈妈…' : '交给爸爸妈妈 ✓'}
                  </button>
                </div>
              </>
            )}

            {(rec.error || submitError) && (
              <p className="mt-2 rounded-xl bg-ultra/10 p-2 text-center text-[12.5px] text-ultra">
                {rec.error || submitError}
              </p>
            )}
            {!rec.error && (
              <p className="mt-2 text-center text-[11.5px] text-mute">
                {rec.state === 'recording'
                  ? '点一次开始、点一次结束，不用一直按着'
                  : rec.state === 'done'
                    ? '满意就交给爸爸妈妈，不满意可以重录'
                    : mode === 'browse'
                      ? '想读给爸爸妈妈听就录一段，不想录也可以直接完成'
                      : `翻着页把 ${piece.pages.length} 页完整读一遍`}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 关卡进度。状态用显式判断，不要用 nth-of-type —— 返回箭头也是同类元素，
 * 会把序号顶掉一位。
 *
 * 纯图绘本只有两步（浏览 → 录音），画三个点会让孩子以为还差一关。
 */
function StageBar({
  stage,
  total,
  onBack,
}: {
  stage: Stage
  total: 2 | 3
  onBack: () => void
}) {
  const items = (
    total === 2
      ? [
          { n: 1 as Stage, node: Butterfly, on: 'text-sun' },
          { n: 2 as Stage, node: Bolt, on: 'text-ultra' },
        ]
      : [
          { n: 1 as Stage, node: Butterfly, on: 'text-sun' },
          { n: 2 as Stage, node: Fish, on: 'text-water' },
          { n: 3 as Stage, node: Bolt, on: 'text-ultra' },
        ]
  )
  return (
    <div className="flex items-center gap-2 bg-white px-3 py-2 shadow-sm">
      <button onClick={onBack} className="tap -my-2 px-1 text-2xl leading-none text-[#b3aa9c]">
        ‹
      </button>
      {items.map(({ n, node: Ico, on }, i) => (
        <span key={n} className="flex flex-1 items-center gap-2 last:flex-none">
          <Ico
            className={
              n === stage
                ? `h-7 w-7 shrink-0 ${on}`
                : n < stage
                  ? 'h-5 w-5 shrink-0 text-[#9fd0a8]'
                  : 'h-5 w-5 shrink-0 text-[#d3cbbf]'
            }
          />
          {i < items.length - 1 && <i className="h-0.5 flex-1 rounded bg-[#e6e0d6]" />}
        </span>
      ))}
    </div>
  )
}

/** 能量槽随音量涨落，让孩子知道麦克风真的在听 */
function EnergyBar({ level }: { level: number }) {
  return (
    <div className="mt-2.5 flex items-center gap-2.5 rounded-xl bg-[#f1ece3] px-2.5 py-1.5">
      <Bolt className="h-4 w-4 shrink-0 text-ultra" />
      <div className="h-3.5 flex-1 overflow-hidden rounded-full bg-[#e0d8cb]">
        <div
          className="h-full rounded-full bg-linear-to-r from-sun to-ultra transition-[width] duration-100"
          style={{ width: `${Math.max(4, level * 100)}%` }}
        />
      </div>
    </div>
  )
}

function PageArrow({
  side,
  disabled,
  onClick,
}: {
  side: 'left' | 'right'
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={side === 'left' ? '上一页' : '下一页'}
      // 不能贴边：安卓 10+ 左右边缘各约 20~24dp 是系统返回手势区，
      // 按钮压在那儿孩子一点就把阅读退出了。往里挪、并且做大一点好按。
      className={`tap absolute ${side === 'left' ? 'left-4' : 'right-4'} top-1/2 grid h-14 w-14 -translate-y-1/2 place-items-center rounded-full bg-black/30 text-3xl leading-none text-white active:bg-black/55 ${
        disabled ? 'opacity-0' : ''
      }`}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  )
}

function FishTank({ total, filled }: { total: number; filled: number }) {
  const slots = useMemo(() => Array.from({ length: total }, (_, i) => i < filled), [total, filled])
  return (
    <div className="mt-2.5 flex justify-between gap-1 rounded-xl bg-[#dcf0f9] px-2 py-1.5">
      {slots.map((on, i) => (
        <span
          key={i}
          className={`grid aspect-square flex-1 place-items-center rounded-full ${
            on ? 'bg-water text-white' : 'bg-[#c4e3f1]'
          }`}
        >
          {on && <Fish className="h-3.5 w-3.5" />}
        </span>
      ))}
    </div>
  )
}
