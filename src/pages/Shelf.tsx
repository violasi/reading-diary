/**
 * 我的书架：所有导入过的书，不管有没有交过录音。
 *
 * 按书名去重（同名以最新导入的为准）—— 一本书常常要看好几天，
 * 每天的任务包里都有它，书架上却只该有一本。
 *
 * 不按日期分组：去重之后一本书只对应「最近一次出现的那天」，
 * 再按天分栏会让人误以为那天只读了这一本。
 */
import { useEffect, useState } from 'react'
import { listLibrary, type LibraryBook } from '../lib/db'

interface Shown extends LibraryBook {
  coverUrl?: string
}

export default function Shelf({
  today,
  onOpen,
  onExit,
}: {
  today: string
  onOpen: (date: string, pieceId: string) => void
  onExit: () => void
}) {
  const [books, setBooks] = useState<Shown[] | null>(null)

  useEffect(() => {
    let alive = true
    const urls: string[] = []
    void (async () => {
      const lib = await listLibrary()
      // 读盘期间可能已经离开书架了。cleanup 早跑完的话它看到的 urls 还是空的，
      // 晚建出来的 URL 就没人回收 —— 自己就地撤掉
      if (!alive) return
      const shown: Shown[] = lib.map((b) => {
        if (!b.cover) return b
        const u = URL.createObjectURL(b.cover)
        urls.push(u)
        return { ...b, coverUrl: u }
      })
      if (!alive) return urls.forEach((u) => URL.revokeObjectURL(u))
      setBooks(shown)
    })()
    return () => {
      alive = false
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-sand">
      <header className="flex items-center gap-2 border-b border-[#eee7dc] bg-white px-3 py-2.5">
        <button
          onClick={onExit}
          className="tap grid h-9 w-9 place-items-center rounded-full bg-[#f1ece3] text-lg text-[#6f665a]"
          aria-label="返回"
        >
          ‹
        </button>
        <span className="text-[15px] font-extrabold">我的书架</span>
        {books?.length ? (
          <span className="ml-auto text-[11px] text-mute">{books.length} 本</span>
        ) : null}
      </header>

      <main className="flex-1 overflow-y-auto p-3">
        {books === null && <p className="py-10 text-center text-sm text-mute">载入中…</p>}
        {books?.length === 0 && (
          <p className="py-10 text-center text-sm text-mute">
            还没有书。让爸爸妈妈导入任务包，书就会收进这里
          </p>
        )}

        {books?.length ? (
          <div className="grid grid-cols-3 gap-2.5">
            {books.map((b) => (
              <button
                key={b.piece.title}
                onClick={() => onOpen(b.date, b.piece.id)}
                className="tap overflow-hidden rounded-xl bg-white text-left shadow-sm"
              >
                <div className="grid aspect-3/4 place-items-center bg-[#f6f2ea]">
                  {b.coverUrl ? (
                    <img src={b.coverUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[11px] text-mute">无封面</span>
                  )}
                </div>
                <div className="p-1.5">
                  <div className="truncate text-[11.5px] leading-tight font-bold">
                    {b.piece.title}
                  </div>
                  <div className="mt-0.5 text-[10px] text-mute">
                    {b.piece.pages.length} 页{b.date === today ? ' · 今天' : ''}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : null}
      </main>
    </div>
  )
}
