/**
 * 阅读页。**没有关卡** —— 进书就是自由翻页，听、录、读完了都是随时可用的动作。
 *
 * 早先是三关闯关（听一遍 → 逐页跟读 → 整篇录音），孩子必须按顺序过。实际用下来
 * 问题很明显：读得好的书被迫走完三关，读不动的书卡在录音关退不回去，而"听"
 * 这件事本来就该由孩子自己决定什么时候要。所以改成自由模式：
 *
 *   翻页      左右滑动（箭头是辅助）
 *   听这页    自己不会读的时候点一下
 *   连着听    从当前页一路念到最后，自动翻页
 *   录一段    随时可录，完全可选，不影响完成
 *   读完了    孩子说读完就算读完 —— 这是唯一的完成判据
 *
 * 读完之后这本书**不锁**：还能从今日任务进来随便翻，方便复习。
 */
import { useEffect, useRef, useState } from 'react'
import type { PackPiece, PieceProgress } from '../types'
import { canPlay } from '../types'
import HeroImg from '../components/HeroImg'
import { Play } from '../components/Icons'
import { useRecorder } from '../lib/recorder'
import { useBookPlayer } from '../lib/audio'
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
  const [idx, setIdx] = useState(0)
  /** 'none' | 'page'（只念这页）| 'book'（连着念下去） */
  const [playMode, setPlayMode] = useState<'none' | 'page' | 'book'>('none')
  /** 录音面板是展开的吗。录音是可选动作，不占着主界面 */
  const [recOpen, setRecOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [celebrate, setCelebrate] = useState(false)
  // 交完录音的变身孩子很喜欢，所以录音这条路也要有。用本地状态记一下是不是
  // 刚交的录音 —— progress.recorded 要等父组件回传，变身屏当场读不到
  const [justGaveRec, setJustGaveRec] = useState(false)

  const rec = useRecorder()
  const player = useBookPlayer()
  const hasAudio = canPlay(piece)
  const last = piece.pages.length - 1
  const page = piece.pages[idx]

  const stopPlay = () => {
    player.stop()
    setPlayMode('none')
  }

  // ---- 翻页 ----
  const turnTo = (i: number) => {
    const v = Math.max(0, Math.min(last, i))
    if (v === idx) return
    stopPlay() // 翻页就停掉正在念的，不然上一页的声音压着新页
    setIdx(v)
  }
  const swipe = useSwipe(() => turnTo(idx - 1), () => turnTo(idx + 1))

  // ---- 听 ----
  const listenPage = () => {
    if (playMode === 'page') return stopPlay()
    stopPlay()
    setPlayMode('page')
    player.playPage(piece, urls, idx, () => setPlayMode('none'))
  }

  const listenOn = () => {
    if (playMode === 'book') return stopPlay()
    stopPlay()
    setPlayMode('book')
    // 连着听会自己翻页，所以 onPage 直接设页码 —— 不能走 turnTo，
    // 那个会 stopPlay 把自己掐断
    player.playFrom(piece, urls, idx, setIdx, () => setPlayMode('none'))
  }

  // ---- 试听刚录的那段 ----
  // 必须握在 ref 里：早先每次现造一个游离的 Audio，谁都停不住它 ——
  // 孩子点了试听马上返回，那段录音会在首页继续响到播完
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
  useEffect(() => stopPreview, [])

  // ---- 离开 ----
  /**
   * 有还没落盘的录音：正在录，或录完了还没交（blob 只在内存里，退出就没了）。
   * 已经交过的不算 —— 否则交完后按实体返回键会冤枉地弹「录音还没交」。
   */
  const unsaved = rec.state === 'recording' || (rec.state === 'done' && !!rec.blob)

  const handleBack = () => {
    if (rec.state === 'recording' && !window.confirm('正在录音，真的要离开吗？')) return
    if (
      rec.state === 'done' &&
      rec.blob &&
      !window.confirm('这段录音还没交给爸爸妈妈，离开就没有了。真的要走吗？')
    )
      return
    stopPlay()
    stopPreview()
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

  // ---- 读完了 ----
  const finish = () => {
    stopPlay()
    onProgress({ finished: true })
    setCelebrate(true)
  }

  // 庆祝屏盖满全屏，否则底部操作条会露在外面
  if (celebrate)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-deep px-6 text-center text-white">
        <HeroImg className="h-40 w-40 animate-pulse object-contain drop-shadow-[0_0_30px_rgba(255,138,138,.85)]" />
        <h2 className="text-xl font-extrabold">《{piece.title}》读完啦！</h2>
        <p className="text-[13px] opacity-90">
          {justGaveRec || progress.recorded
            ? '录音已经交给爸爸妈妈'
            : '想读给爸爸妈妈听的话，随时可以录一段'}
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
      <header className="flex items-center gap-2 border-b border-[#eee7dc] bg-white px-3 py-2.5">
        <button
          onClick={handleBack}
          className="tap grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f1ece3] text-lg text-[#6f665a]"
          aria-label="返回"
        >
          ‹
        </button>
        <span className="truncate text-[13px] font-bold">{piece.title}</span>
        {progress.finished && (
          <span className="ml-auto shrink-0 rounded-full bg-[#3fae63]/12 px-2 py-0.5 text-[11px] font-bold text-[#3fae63]">
            读完了 ✓
          </span>
        )}
      </header>

      {/* 中部：整页原图。min-h-0 是关键 —— 否则 flex 子项按内容撑开，
          底部那行字会被裁掉，而那行字正是孩子要读的内容 */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-2.5"
        {...swipe}
      >
        {page && urls[page.image] ? (
          <img
            src={urls[page.image]}
            alt=""
            className="max-h-full max-w-full rounded-lg object-contain shadow-md"
          />
        ) : (
          <p className="text-mute">这一页的图片丢了</p>
        )}

        <PageArrow side="left" disabled={idx === 0} onClick={() => turnTo(idx - 1)} />
        <PageArrow side="right" disabled={idx >= last} onClick={() => turnTo(idx + 1)} />
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-0.5 text-[11px] font-bold text-white">
          {idx + 1} / {piece.pages.length}
        </span>
      </div>

      <div className="border-t border-[#eee7dc] bg-white p-3">
        {recOpen ? (
          <RecordPanel
            rec={rec}
            submitting={submitting}
            submitError={submitError}
            onPreview={playPreview}
            onCancel={() => {
              stopPreview()
              rec.reset()
              setRecOpen(false)
            }}
            onSubmit={async () => {
              setSubmitting(true)
              setSubmitError(null)
              try {
                await onSubmitRecording(rec.blob!)
                stopPreview()
                rec.reset()
                setRecOpen(false)
                // 交了录音就算读完这本，并且给变身 —— 这是孩子最喜欢的那一下
                setJustGaveRec(true)
                setCelebrate(true)
              } catch {
                // 存不进去最常见的原因是空间满了。blob 还在内存里，所以不清 rec ——
                // 让孩子能原地再点一次，不用重读一遍
                setSubmitError('没交上，再试一次？')
              } finally {
                setSubmitting(false)
              }
            }}
          />
        ) : (
          <>
            {/* 听和录都是「想用再用」的动作，压成一行小按钮；
                「读完了」才是主按钮 */}
            <div className="flex gap-2">
              {hasAudio && (
                <>
                  <button
                    onClick={listenPage}
                    className={`tap flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-[13px] font-bold ${
                      playMode === 'page'
                        ? 'bg-water text-white'
                        : 'bg-[#f1ece3] text-[#6f665a] active:bg-[#e7e0d4]'
                    }`}
                  >
                    <Play className="h-3.5 w-3.5" />
                    {playMode === 'page' ? '在念…' : '听这页'}
                  </button>
                  <button
                    onClick={listenOn}
                    className={`tap flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-[13px] font-bold ${
                      playMode === 'book'
                        ? 'bg-water text-white'
                        : 'bg-[#f1ece3] text-[#6f665a] active:bg-[#e7e0d4]'
                    }`}
                  >
                    <Play className="h-3.5 w-3.5" />
                    {playMode === 'book' ? '连着念…' : '连着听'}
                  </button>
                </>
              )}
              <button
                onClick={() => setRecOpen(true)}
                className={`tap flex items-center justify-center gap-1.5 rounded-xl bg-[#f1ece3] py-2.5 text-[13px] font-bold text-[#6f665a] active:bg-[#e7e0d4] ${
                  hasAudio ? 'flex-1' : 'flex-1'
                }`}
              >
                <span className="text-ultra">●</span> 录一段
              </button>
            </div>

            <button
              onClick={finish}
              className={`tap mt-2.5 w-full rounded-2xl py-4 font-extrabold text-white ${
                progress.finished
                  ? 'bg-[#9ec8ab] text-[15px]'
                  : idx >= last
                    ? 'bg-sun text-xl active:bg-sun/85'
                    : 'bg-sun/80 text-lg active:bg-sun/85'
              }`}
            >
              {progress.finished ? '再读一次也算读完啦 ✓' : '读完了 ✓'}
            </button>

            <p className="mt-2 text-center text-[11.5px] text-mute">
              {progress.finished
                ? '这本已经算今天读过了，想再翻翻随时可以'
                : hasAudio
                  ? '左右滑动翻页 · 不会读就点「听这页」'
                  : '左右滑动翻页 · 和爸爸妈妈一起看'}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/** 录音面板。录音完全可选，所以它是展开出来的，不占主界面 */
function RecordPanel({
  rec,
  submitting,
  submitError,
  onPreview,
  onCancel,
  onSubmit,
}: {
  rec: ReturnType<typeof useRecorder>
  submitting: boolean
  submitError: string | null
  onPreview: (b: Blob) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <>
      {rec.state === 'idle' && !rec.blob && (
        <>
          <button
            onClick={rec.start}
            className="tap flex w-full items-center justify-center gap-2.5 rounded-2xl bg-ultra py-4 text-xl font-extrabold text-white active:bg-ultra/85"
          >
            <span className="text-2xl leading-none">●</span> 开始录音
          </button>
          <button
            onClick={onCancel}
            className="tap mt-2 w-full rounded-2xl bg-[#f1ece3] py-3 text-[14px] font-bold text-[#6f665a]"
          >
            不录了
          </button>
        </>
      )}

      {rec.state === 'recording' && (
        <>
          <button
            onClick={rec.stop}
            className="tap flex w-full items-center justify-center gap-2.5 rounded-2xl bg-ultra py-4 text-xl font-extrabold text-white"
          >
            <span className="text-lg leading-none">■</span> 录好了
            <span className="text-sm font-bold opacity-80">{fmt(rec.seconds)}</span>
          </button>
          <EnergyBar level={rec.level} />
        </>
      )}

      {rec.state === 'done' && rec.blob && (
        <>
          <button
            onClick={() => onPreview(rec.blob!)}
            className="tap flex w-full items-center justify-center gap-2 rounded-2xl bg-[#f1ece3] py-3.5 text-[15px] font-bold text-[#6f665a] active:bg-[#e7e0d4]"
          >
            <Play className="h-4 w-4" /> 听听我读的（{fmt(rec.seconds)}）
          </button>
          <div className="mt-2.5 flex gap-2.5">
            <button
              onClick={rec.reset}
              className="tap flex-1 rounded-2xl bg-[#f1ece3] py-3.5 text-[15px] font-bold text-[#6f665a]"
            >
              重录
            </button>
            <button
              disabled={submitting}
              onClick={onSubmit}
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
      {!rec.error && !submitError && (
        <p className="mt-2 text-center text-[11.5px] text-mute">
          {rec.state === 'recording'
            ? '点一次开始、点一次结束，不用一直按着'
            : rec.state === 'done'
              ? '满意就交给爸爸妈妈，不满意可以重录'
              : '想读给爸爸妈妈听就录一段，不录也没关系'}
        </p>
      )}
    </>
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
      // 按钮压在那儿孩子一点就把阅读退出了
      className={`tap absolute ${side === 'left' ? 'left-4' : 'right-4'} top-1/2 grid h-14 w-14 -translate-y-1/2 place-items-center rounded-full bg-black/30 text-3xl leading-none text-white active:bg-black/55 ${
        disabled ? 'opacity-0' : ''
      }`}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  )
}

/** 录音时的实时音量条，给孩子「麦克风真的在听」的确认 */
function EnergyBar({ level }: { level: number }) {
  return (
    <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-[#f1ece3]">
      <div
        className="h-full rounded-full bg-linear-to-r from-sun to-ultra transition-[width] duration-100"
        style={{ width: `${Math.max(4, level * 100)}%` }}
      />
    </div>
  )
}
