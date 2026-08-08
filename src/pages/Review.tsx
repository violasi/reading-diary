/**
 * 复习模式：孩子想再看一遍以前读过的书。
 *
 * 刻意做得比阅读页轻 —— 没有关卡、不录音、不写任何进度。
 * 复习是「想看就看」，不该再算一次打卡，也不该把当天进度搅乱。
 */
import { useState } from 'react'
import type { PackPiece } from '../types'
import { bookAudioOf, hasPageAudio } from '../types'
import { useBookPlayer } from '../lib/audio'
import { useSwipe } from '../lib/swipe'
import { Play } from '../components/Icons'

export default function Review({
  piece,
  urls,
  onExit,
}: {
  piece: PackPiece
  urls: Record<string, string>
  onExit: () => void
}) {
  const [idx, setIdx] = useState(0)
  /** 'none' | 'page'（只念这页）| 'whole'（整本一条音轨，不跟页码） */
  const [playMode, setPlayMode] = useState<'none' | 'page' | 'whole'>('none')
  const { playPage, playWhole, stop } = useBookPlayer()

  const page = piece.pages[idx]
  const last = piece.pages.length - 1
  // 纯图绘本没有可播的东西，按钮按下去什么都不会发生 —— 干脆不给
  const pageAudio = hasPageAudio(piece)
  const bookAudio = !!bookAudioOf(piece)

  const go = (next: number) => {
    // 和阅读页同一条规矩：整本音轨与页码无关，翻页不该把它掐断
    if (playMode !== 'whole') {
      stop()
      setPlayMode('none')
    }
    setIdx(Math.max(0, Math.min(last, next)))
  }

  // 复习页和阅读页一样以滑动为主：孩子点不准贴边的小箭头，
  // 而边缘正好是安卓的系统手势区，一误触就退出了
  const swipe = useSwipe(() => go(idx - 1), () => go(idx + 1))

  const listen = () => {
    if (playMode === 'page') {
      stop()
      return setPlayMode('none')
    }
    stop()
    setPlayMode('page')
    playPage(piece, urls, idx, () => setPlayMode('none'))
  }

  const listenWhole = () => {
    if (playMode === 'whole') {
      stop()
      return setPlayMode('none')
    }
    stop()
    setPlayMode('whole')
    playWhole(piece, urls, () => setPlayMode('none'))
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-[#eee7dc] bg-white px-3 py-2.5">
        <button
          onClick={() => {
            stop()
            onExit()
          }}
          className="tap grid h-9 w-9 place-items-center rounded-full bg-[#f1ece3] text-lg text-[#6f665a]"
          aria-label="返回"
        >
          ‹
        </button>
        <span className="truncate text-[13px] font-bold">{piece.title}</span>
        <span className="ml-auto shrink-0 text-[11px] text-mute">复习</span>
      </header>

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

        <Arrow side="left" disabled={idx === 0} onClick={() => go(idx - 1)} />
        <Arrow side="right" disabled={idx >= last} onClick={() => go(idx + 1)} />
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-0.5 text-[11px] font-bold text-white">
          {idx + 1} / {piece.pages.length}
        </span>
      </div>

      <div className="border-t border-[#eee7dc] bg-white p-3">
        {pageAudio && (
          <button
            onClick={listen}
            className={`tap flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-lg font-extrabold text-white ${
              playMode === 'page' ? 'bg-water/70' : 'bg-water'
            }`}
          >
            <Play className="h-5 w-5" />
            {playMode === 'page' ? '正在念…' : '听这页'}
          </button>
        )}
        {bookAudio && (
          <button
            onClick={listenWhole}
            className={`tap flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-lg font-extrabold text-white ${
              playMode === 'whole' ? 'bg-water/70' : 'bg-water'
            } ${pageAudio ? 'mt-2' : ''}`}
          >
            <Play className="h-5 w-5" />
            {playMode === 'whole' ? '在放…（可以边听边翻页）' : '整本听'}
          </button>
        )}
        {!pageAudio && !bookAudio && (
          <p className="py-1 text-center text-[12px] text-mute">
            左右翻页，和爸爸妈妈一起再看一遍（第 {idx + 1} / {piece.pages.length} 页）
          </p>
        )}
      </div>
    </div>
  )
}

function Arrow({
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
      // 别贴边：安卓 10+ 左右边缘各约 20~24dp 是系统返回手势区
      className={`absolute top-1/2 -translate-y-1/2 grid h-14 w-14 place-items-center rounded-full bg-black/30 text-3xl leading-none text-white ${
        side === 'left' ? 'left-4' : 'right-4'
      } ${disabled ? 'pointer-events-none opacity-0' : ''}`}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  )
}
