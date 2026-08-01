import type { DayProgress, PackPiece } from '../types'
import { emptyProgress, isPieceDone, modeOf } from '../types'
import type { StoredPack } from '../lib/db'
import { HERO_NAME } from '../data/heroes'
import HeroImg from '../components/HeroImg'
import { Bolt, Book, Butterfly, Fish, Star } from '../components/Icons'

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
  const remaining = pieces.filter((p) => !isPieceDone(progress[p.id] ?? emptyProgress(), p)).length

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
              onOpen={() => onOpenPiece(piece.id)}
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
}: {
  piece: PackPiece
  cover?: string
  progress: DayProgress[string]
  onOpen: () => void
}) {
  const done = isPieceDone(progress, piece)
  // 纯图绘本只有两步，画三个点会让孩子以为还差一关
  const chips =
    modeOf(piece) === 'browse'
      ? [
          { on: progress.browsed, node: <Butterfly className="h-4 w-4" />, color: 'text-sun' },
          { on: progress.recorded, node: <Bolt className="h-4 w-4" />, color: 'text-ultra' },
        ]
      : [
          { on: progress.listened, node: <Butterfly className="h-4 w-4" />, color: 'text-sun' },
          {
            on: progress.pagesRead >= piece.pages.length,
            node: <Fish className="h-4 w-4" />,
            color: 'text-water',
          },
          { on: progress.recorded, node: <Bolt className="h-4 w-4" />, color: 'text-ultra' },
        ]

  return (
    <button
      onClick={done ? undefined : onOpen}
      disabled={done}
      className={`flex items-center gap-3 rounded-2xl bg-white p-2.5 text-left shadow-sm ${
        done ? 'opacity-60' : 'active:bg-black/5'
      }`}
    >
      {cover && <img src={cover} alt="" className="h-[74px] w-14 rounded-lg object-cover" />}
      <div className="min-w-0 flex-1">
        <div className="text-[15px] leading-tight font-bold">{piece.title}</div>
        <div className="mt-0.5 text-[11px] text-mute">
          {piece.level ? `${piece.level} · ` : ''}
          {piece.pages.length} 页
        </div>
        <div className="mt-1.5 flex gap-1.5">
          {chips.map((c, i) => (
            <span key={i} className={c.on ? c.color : 'text-[#cfc7bb]'}>
              {c.node}
            </span>
          ))}
        </div>
      </div>
      {done && (
        <span className="mr-1 grid h-10 w-10 -rotate-12 place-items-center rounded-full border-[2.5px] border-dashed border-ultra text-[9px] leading-tight font-extrabold text-ultra">
          读完
          <br />
          啦
        </span>
      )}
    </button>
  )
}
