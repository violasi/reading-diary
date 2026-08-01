import { useEffect, useMemo, useState } from 'react'
import HeroImg from '../components/HeroImg'
import { loadStars } from '../lib/db'
import { Star } from '../components/Icons'
import type { PackManifest } from '../types'

/** 我的：一页滚动，不分 tab。日历本身就是收集册 */
export default function Me({
  date,
  manifest,
  doneDates,
  onExit,
}: {
  date: string
  manifest: PackManifest | null
  /** 真正读完的日子。统计和盖章都以这个为准 */
  doneDates: string[]
  onExit: () => void
}) {
  const [stars, setStars] = useState<Record<string, number>>({})

  useEffect(() => {
    void loadStars(date).then(setStars)
  }, [date])

  // 盖章只看「读完了」。只点进来挑了个奥特曼的日子不算 ——
  // 否则连续天数会虚高，孩子一眼就看出来这章不值钱
  const done = useMemo(() => new Set(doneDates), [doneDates])
  const { longest, total } = useMemo(() => streaks(doneDates), [doneDates])
  const cells = useMemo(() => monthCells(date), [date])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between bg-linear-160 from-deep to-[#2e86b8] px-4 py-3 text-white">
        <div>
          <div className="text-xs opacity-85">我的收获</div>
          <div className="mt-1 flex gap-5">
            <span className="flex flex-col text-[10.5px] opacity-90">
              <b className="text-xl leading-tight">{longest}</b>最长连续
            </span>
            <span className="flex flex-col text-[10.5px] opacity-90">
              <b className="text-xl leading-tight">{total}</b>总共读了
            </span>
          </div>
        </div>
        <button onClick={onExit} className="tap -mt-1 -mr-1 px-2 text-2xl leading-none">
          ‹
        </button>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto p-3">
        <section className="rounded-2xl bg-white p-3 shadow-sm">
          <h3 className="mb-2 flex justify-between text-[13px] text-[#6f665a]">
            打卡日历
            <span className="text-[11px] font-normal text-mute">断了不归零</span>
          </h3>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((c, i) =>
              c === null ? (
                <span key={i} />
              ) : (
                <span
                  key={i}
                  className={`grid aspect-square place-items-center rounded-md text-[11px] ${
                    done.has(c.iso) ? 'bg-[#fdeed3] p-0.5' : 'bg-sand text-[#c2b9ab]'
                  }`}
                >
                  {done.has(c.iso) ? (
                    <HeroImg
                      className="h-full w-full object-contain"
                      fallback={<span className="text-[13px] text-sun">●</span>}
                    />
                  ) : (
                    c.day
                  )}
                </span>
              ),
            )}
          </div>
        </section>

        <section className="rounded-2xl bg-white p-3 shadow-sm">
          <h3 className="mb-1 text-[13px] text-[#6f665a]">爸爸妈妈的星星</h3>
          {!manifest && <p className="py-3 text-center text-[12px] text-mute">今天还没有任务</p>}
          {manifest?.pieces.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between border-t border-[#f4f0e8] py-2 text-[12px] first:border-0"
            >
              <span className="truncate pr-2">{p.title}</span>
              <span className="flex shrink-0 gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star
                    key={n}
                    className={`h-4 w-4 ${
                      n <= (stars[p.id] ?? 0) ? 'text-sun' : 'text-[#ddd6ca]'
                    }`}
                  />
                ))}
              </span>
            </div>
          ))}
        </section>
      </main>
    </div>
  )
}

/** 最长连续天数 + 总天数。断了不归零，所以只算历史最长，不算「当前连续」 */
function streaks(isoDays: string[]) {
  const sorted = [...isoDays].sort()
  let longest = 0
  let run = 0
  let prev: number | null = null
  for (const d of sorted) {
    const t = Date.parse(d + 'T00:00:00')
    run = prev !== null && t - prev === 86400000 ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = t
  }
  return { longest, total: sorted.length }
}

/** 当月日历格子，周一起始 */
function monthCells(iso: string) {
  const [y, m] = iso.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const lead = (first.getDay() + 6) % 7 // 周一 = 0
  const daysInMonth = new Date(y, m, 0).getDate()
  const cells: ({ day: number; iso: string } | null)[] = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= daysInMonth; d++)
    cells.push({ day: d, iso: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` })
  return cells
}
