/**
 * 左右滑动翻页。
 *
 * 孩子的小手点不准角落里的箭头，一不小心就滑到屏幕边缘、被安卓的系统手势
 * 抢走（右边缘=返回，底部上滑=回主屏），阅读直接被退出。滑动翻页比点箭头
 * 自然得多，也不用瞄准。
 *
 * 两个要点：
 *   1. 从屏幕边缘起手的滑动一律不算 —— 那一条是系统手势区（安卓 10+ 左右
 *      各约 20~24dp），我们跟系统抢只会两边都不灵。让孩子从画面中间划。
 *   2. 竖向位移大于横向就不算翻页 —— 孩子常常是斜着划，别把想上下划的动作
 *      误判成翻页。
 */
import { useRef, type TouchEvent } from 'react'

/** 起手点离左右边缘多少像素以内就忽略。比系统手势区留足余量 */
const EDGE_DEAD_ZONE = 44
/** 横向要划够这么多像素才算翻页。太小会把点击的轻微位移误判成滑动 */
const MIN_DISTANCE = 45

export function useSwipe(onPrev: () => void, onNext: () => void) {
  const start = useRef<{ x: number; y: number; valid: boolean } | null>(null)

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0]
    if (!t) return
    const w = window.innerWidth
    start.current = {
      x: t.clientX,
      y: t.clientY,
      valid: t.clientX > EDGE_DEAD_ZONE && t.clientX < w - EDGE_DEAD_ZONE,
    }
  }

  const onTouchEnd = (e: TouchEvent) => {
    const s = start.current
    start.current = null
    if (!s || !s.valid) return
    const t = e.changedTouches[0]
    if (!t) return
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) <= Math.abs(dy)) return
    // 手势方向按「翻书」来：往左划 = 看下一页
    if (dx < 0) onNext()
    else onPrev()
  }

  return { onTouchStart, onTouchEnd }
}
