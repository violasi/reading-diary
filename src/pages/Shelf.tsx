/**
 * 我的书架：所有导入过的书，不管有没有交过录音。
 *
 * **按系列收起来**：书多了（现在上百本）平铺三列要滑很久，而且同一套书散落在
 * 各处。所以先按分组（系列优先、回退到分级，见 types.ts 的 groupOf）折成一个个
 * 文件夹，点开才展开那一套。默认全收起。
 *
 * 按书名去重（同名以最新导入的为准）—— 一本书常常要看好几天，
 * 每天的任务包里都有它，书架上却只该有一本。
 *
 * 不按日期分组：去重之后一本书只对应「最近一次出现的那天」，
 * 再按天分栏会让人误以为那天只读了这一本。
 */
import { useEffect, useMemo, useState } from 'react'
import { groupOf } from '../types'
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
  /** 展开着的分组。默认全收起 —— 书架是「找书」的地方，不是「看全部」的地方 */
  const [open, setOpen] = useState<string[]>([])

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

  /** 分组。组内保持 listLibrary 的顺序（最近读的在前），组间按组里最新那本排 */
  const groups = useMemo(() => {
    if (!books) return null
    const m = new Map<string, Shown[]>()
    for (const b of books) {
      const k = groupOf(b.piece)
      ;(m.get(k) ?? m.set(k, []).get(k)!).push(b)
    }
    return [...m.entries()]
      .map(([name, list]) => ({ name, list, newest: list[0]?.date ?? '' }))
      .sort((a, b) => b.newest.localeCompare(a.newest))
  }, [books])

  const toggle = (name: string) =>
    setOpen((o) => (o.includes(name) ? o.filter((x) => x !== name) : [...o, name]))

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

        {groups?.length ? (
          <div className="space-y-2">
            {groups.map((g) => {
              const expanded = open.includes(g.name)
              return (
                <div key={g.name} className="overflow-hidden rounded-xl bg-white shadow-sm">
                  <button
                    onClick={() => toggle(g.name)}
                    className="tap flex w-full items-center gap-2.5 p-2.5 text-left"
                  >
                    {/* 用组里第一本的封面当文件夹图标，比一个通用图标好认 */}
                    <span className="relative h-11 w-9 shrink-0">
                      <span className="absolute inset-0 translate-x-1 translate-y-0.5 rounded-md bg-[#e8e1d5]" />
                      {g.list[0]?.coverUrl ? (
                        <img
                          src={g.list[0].coverUrl}
                          alt=""
                          className="absolute inset-0 h-full w-full rounded-md object-cover shadow-sm"
                        />
                      ) : (
                        <span className="absolute inset-0 grid place-items-center rounded-md bg-[#f6f2ea] text-[9px] text-mute">
                          无
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-bold">{g.name}</span>
                      <span className="mt-0.5 block text-[11px] text-mute">{g.list.length} 本</span>
                    </span>
                    <span
                      className={`shrink-0 text-[15px] text-[#b5ab9c] transition-transform ${
                        expanded ? 'rotate-90' : ''
                      }`}
                    >
                      ›
                    </span>
                  </button>

                  {expanded && (
                    <div className="grid grid-cols-3 gap-2.5 border-t border-[#f1ece3] p-2.5">
                      {g.list.map((b) => (
                        <button
                          key={b.piece.title}
                          onClick={() => onOpen(b.date, b.piece.id)}
                          className="tap overflow-hidden rounded-xl bg-sand text-left"
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
                  )}
                </div>
              )
            })}
          </div>
        ) : null}
      </main>
    </div>
  )
}
