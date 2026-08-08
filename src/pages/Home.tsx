import type { DayProgress, PackPiece } from '../types'
import { bookAudioOf, canPlay, emptyProgress, isPieceDone } from '../types'
import { useBookPlayer } from '../lib/audio'
import type { StoredPack } from '../lib/db'
import { HERO_NAME } from '../data/heroes'
import HeroImg from '../components/HeroImg'
import { useState } from 'react'
import { Book, Star } from '../components/Icons'

interface Props {
  date: string
  pack: StoredPack | null
  urls: Record<string, string>
  progress: DayProgress
  onOpenPiece: (pieceId: string) => void
  onOpenMe: () => void
  onOpenShelf: () => void
  onOpenParent: () => void
}

export default function Home({
  date,
  pack,
  urls,
  progress,
  onOpenPiece,
  onOpenMe,
  onOpenShelf,
  onOpenParent,
}: Props) {
  const pieces = pack?.manifest.pieces ?? []
  const remaining = pieces.filter((p) => !isPieceDone(progress[p.id] ?? emptyProgress())).length

  /**
   * 裸听：**不进故事页**，就在首页把整本念下去，孩子可以把平板放一边躺着听。
   * 播放器归首页所有，「是哪本书」每次调用时传进去 —— 所以切着听不同的书
   * 也不会用到上一次渲染留下的那本。
   */
  const player = useBookPlayer()
  /** idx 是「念到第几页了」；整本音轨的书对不上页码，所以是 null */
  const [listening, setListening] = useState<{ id: string; idx: number | null } | null>(null)

  const toggleListen = (piece: (typeof pieces)[number]) => {
    if (listening?.id === piece.id) {
      player.stop()
      return setListening(null)
    }
    player.stop()
    // 整本一条音轨的书（牛津树那类）直接放整条，没有页码可报
    if (bookAudioOf(piece)) {
      setListening({ id: piece.id, idx: null })
      player.playWhole(piece, urls, () => setListening(null))
      return
    }
    setListening({ id: piece.id, idx: 0 })
    player.playFrom(
      piece,
      urls,
      0,
      (i) => setListening({ id: piece.id, idx: i }),
      () => setListening(null),
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：陪读的奥特曼固定是泰罗，不用每天挑 */}
      <header className="flex items-center gap-3 bg-linear-160 from-deep to-[#2e86b8] px-4 pt-4 pb-4 text-white">
        <HeroImg
          className="h-[74px] w-[74px] shrink-0 object-contain drop-shadow-[0_3px_8px_rgba(0,0,0,.35)]"
          fallback={<div className="h-[74px] w-[74px] shrink-0" />}
        />
        <div className="min-w-0">
          <div className="text-xs opacity-85">今天陪你读的是</div>
          <div className="truncate text-lg font-extrabold">{HERO_NAME}</div>
        </div>
      </header>

      {/* 书单 */}
      <main className="flex-1 overflow-y-auto p-3">
        {pieces.length > 0 && (
          <p className="mb-2 px-1 text-sm text-mute">
            {remaining > 0 ? `今天还要读 ${remaining} 本` : '今天全部读完啦！'}
          </p>
        )}

        {pieces.length === 0 && (
          <div className="mt-6 rounded-3xl bg-white p-6 text-center shadow-sm">
            <p className="text-base font-bold">今天还没有任务哦</p>
            <p className="mt-1 text-sm text-mute">
              让爸爸妈妈把今天的任务包传过来
              <br />
              （{date}.rdpkg）
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {pieces.map((piece) => (
            <BookCard
              key={piece.id}
              piece={piece}
              cover={piece.cover ? urls[piece.cover] : urls[piece.pages[0]?.image]}
              progress={progress[piece.id] ?? emptyProgress()}
              onOpen={() => {
                player.stop()
                setListening(null)
                onOpenPiece(piece.id)
              }}
              onListen={() => toggleListen(piece)}
              listening={listening?.id === piece.id}
              listeningIdx={listening?.id === piece.id ? listening.idx : null}
            />
          ))}
        </div>

      </main>

      {/* 底栏。「爸爸妈妈」明显小一号且在角落 */}
      <footer className="flex items-stretch gap-2.5 p-3">
        <button
          onClick={onOpenMe}
          className="tap flex-1 rounded-2xl bg-white py-3 text-sm font-bold shadow-sm active:bg-black/5"
        >
          <Star className="mx-auto mb-0.5 h-5 w-5 text-sun" />
          我的
        </button>
        <button
          onClick={onOpenShelf}
          className="tap flex-1 rounded-2xl bg-white py-3 text-sm font-bold shadow-sm active:bg-black/5"
        >
          <Book className="mx-auto mb-0.5 h-5 w-5 text-water" />
          我的书架
        </button>
        <button
          onClick={onOpenParent}
          className="tap w-[74px] rounded-2xl bg-[#e3ded5] text-[10px] leading-tight font-semibold whitespace-pre-line text-[#7d7467] active:bg-[#d8d2c7]"
        >
          {'爸爸\n妈妈'}
        </button>
      </footer>
    </div>
  )
}

function BookCard({
  piece,
  cover,
  progress,
  onOpen,
  onListen,
  listening,
  listeningIdx,
}: {
  piece: PackPiece
  cover?: string
  progress: DayProgress[string]
  onOpen: () => void
  /** 裸听：不进故事页，直接从首页把整本念下去 */
  onListen: () => void
  /**
   * 正在裸听这本吗。**必须和 listeningIdx 分开** —— 整本音轨的书没有页码，
   * idx 是 null，光看 idx 会把「正在听」误判成「没在听」，
   * 按钮就退回耳机图标、孩子再点一下反而是重新开始放
   */
  listening: boolean
  /** 听到第几页了。整本音轨的书对不上页码，是 null */
  listeningIdx: number | null
}) {
  const done = isPieceDone(progress)
  const audio = canPlay(piece)

  return (
    <div
      className={`flex items-center gap-3 rounded-2xl bg-white p-2.5 shadow-sm ${
        done ? 'opacity-75' : ''
      }`}
    >
      {/* 读完之后**不锁**：孩子还要能进去复习。早先是禁用整张卡，
          结果读完的书当天就打不开了 */}
      <button onClick={onOpen} className="tap flex min-w-0 flex-1 items-center gap-3 text-left">
        {cover && <img src={cover} alt="" className="h-[74px] w-14 shrink-0 rounded-lg object-cover" />}
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] leading-tight font-bold">{piece.title}</span>
          <span className="mt-0.5 block text-[11px] text-mute">
            {piece.level ? `${piece.level} · ` : ''}
            {piece.pages.length} 页
          </span>
          <span className="mt-1 block text-[11px] font-bold">
            {listening ? (
              <span className="text-water">
                {listeningIdx === null
                  ? '正在听整本…'
                  : `正在听 · 第 ${listeningIdx + 1} / ${piece.pages.length} 页`}
              </span>
            ) : done ? (
              <span className="text-[#3fae63]">
                读完了 ✓{progress.recorded ? ' · 有录音' : ''}
              </span>
            ) : (
              '\u00a0'
            )}
          </span>
        </span>
      </button>

      {/* 裸听单独一个按钮：孩子想躺着听、不想翻页的时候用 */}
      {audio && (
        <button
          onClick={onListen}
          aria-label="裸听"
          className={`tap grid h-11 w-11 shrink-0 place-items-center rounded-full ${
            listening ? 'bg-water text-white' : 'bg-water/12 text-water active:bg-water/25'
          }`}
        >
          {listening ? (
            <span className="text-lg leading-none">■</span>
          ) : (
            <Headphones className="h-5 w-5" />
          )}
        </button>
      )}
    </div>
  )
}

/** 耳机。裸听用 —— 和「听这页」的播放三角区分开 */
function Headphones({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M16 4a11 11 0 00-11 11v6a3 3 0 003 3h2a2 2 0 002-2v-6a2 2 0 00-2-2H8v-1a8 8 0 0116 0v1h-2a2 2 0 00-2 2v6a2 2 0 002 2h2a3 3 0 003-3v-6A11 11 0 0016 4z"
      />
    </svg>
  )
}
