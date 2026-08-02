import { useEffect, useMemo, useState } from 'react'
import HeroImg from '../components/HeroImg'
import { loadDaySummary } from '../lib/db'
import { Star } from '../components/Icons'


/** 我的：一页滚动，不分 tab。日历本身就是收集册 */
type DaySummary = Awaited<ReturnType<typeof loadDaySummary>>

export default function Me({
  date,
  doneDates,
  onExit,
}: {
  date: string
  /** 真正读完的日子。统计和盖章都以这个为准 */
  doneDates: string[]
  onExit: () => void
}) {
  // 日历和星星是联动的：点哪天就看那天读了什么、得了几星。默认看今天
  const [picked, setPicked] = useState(date)
  const [day, setDay] = useState<DaySummary | null>(null)

  useEffect(() => {
    let alive = true
    void loadDaySummary(picked).then((d) => {
      if (alive) setDay(d)
    })
    return () => {
      alive = false
    }
  }, [picked])

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
                <button
                  key={i}
                  onClick={() => setPicked(c.iso)}
                  className={`tap grid aspect-square place-items-center rounded-md text-[11px] ${
                    done.has(c.iso) ? 'bg-[#fdeed3] p-0.5' : 'bg-sand text-[#c2b9ab]'
                  } ${picked === c.iso ? 'ring-2 ring-sun' : ''}`}
                >
                  {done.has(c.iso) ? (
                    <HeroImg
                      className="h-full w-full object-contain"
                      fallback={<span className="text-[13px] text-sun">●</span>}
                    />
                  ) : (
                    c.day
                  )}
                </button>
              ),
            )}
          </div>
        </section>

        <section className="rounded-2xl bg-white p-3 shadow-sm">
          <h3 className="mb-1 flex items-baseline justify-between text-[13px] text-[#6f665a]">
            <span>{picked === date ? '今天读的' : `${picked.slice(5)} 读的`}</span>
            <span className="text-[11px] font-normal text-mute">
              {picked === date ? '点日历看以前' : '点日历换一天'}
            </span>
          </h3>

          {day === null && <p className="py-3 text-center text-[12px] text-mute">载入中…</p>}
          {day && !day.books.length && (
            <p className="py-3 text-center text-[12px] text-mute">
              {picked === date ? '今天还没有任务' : '这天没有布置任务'}
            </p>
          )}
          {day?.books.map((b) => (
            <div
              key={b.id}
              className="flex items-center justify-between border-t border-[#f4f0e8] py-2 text-[12px] first:border-0"
            >
              <span className="truncate pr-2">
                {b.title}
                {/* 没读完的书标出来，否则「没星」看着像家长忘了打分 */}
                {!b.finished && <span className="ml-1 text-[10.5px] text-mute">未读完</span>}
              </span>
              <span className="flex shrink-0 gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star
                    key={n}
                    className={`h-4 w-4 ${n <= b.stars ? 'text-sun' : 'text-[#ddd6ca]'}`}
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
