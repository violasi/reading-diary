/**
 * 念书的播放器。**全 App 只有这一份实现** —— 首页裸听、阅读页的「听这页 / 连着听」、
 * 复习页都用它。顺序播放的逻辑写两遍必然跑偏（早先 TTS 取消那个 bug 就是因为
 * 有两份，改了一处漏了另一处）。
 *
 * 「是哪本书」是每次调用时传进来的，不绑在 hook 上：首页要能对任意一本书裸听，
 * 绑死一本的话切换时会用到上一次渲染留下的那本。
 */
import { useEffect, useRef } from 'react'
import type { PackPiece } from '../types'
import { bookAudioOf } from '../types'

export function useBookPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!audioRef.current) audioRef.current = new Audio()

  /**
   * 播放代号。两件事都靠它：
   *   1. speechSynthesis.cancel() 之后被取消的 utterance 仍可能触发 onend，
   *      而顺序播放的 onDone 是「翻下一页继续念」—— 孩子点了停止却还在自动翻页
   *   2. a.src = '' 在部分浏览器会触发一次 error 事件，同理会把页码往下推
   */
  const genRef = useRef(0)

  const stop = () => {
    genRef.current++
    const a = audioRef.current!
    a.onended = null
    a.onerror = null
    a.pause()
    window.speechSynthesis?.cancel()
  }

  // 离开时一定要停掉，否则会在后台继续响
  useEffect(() => {
    const a = audioRef.current!
    return () => {
      genRef.current++
      a.onended = null
      a.onerror = null
      a.pause()
      a.src = ''
      window.speechSynthesis?.cancel()
    }
  }, [])

  /** 念一段：有真人音就放，没有就用系统 TTS 兜底 */
  const speak = (
    src: string | undefined,
    text: string | undefined,
    lang: string,
    onDone: () => void,
  ) => {
    const gen = genRef.current
    const guarded = () => {
      if (gen === genRef.current) onDone()
    }
    const a = audioRef.current!
    if (src) {
      a.pause()
      a.src = src
      a.onended = guarded
      a.onerror = guarded
      void a.play().catch(guarded)
      return
    }
    const synth = window.speechSynthesis
    if (!text || !synth) return guarded()
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang
    u.rate = 0.8 // 给孩子跟读，慢一点
    u.onend = guarded
    u.onerror = guarded
    synth.speak(u)
  }

  const at = (piece: PackPiece, urls: Record<string, string>, i: number) => {
    const pg = piece.pages[i]
    return { src: pg?.audio ? urls[pg.audio] : undefined, text: pg?.text }
  }

  /** 只念第 i 页 */
  const playPage = (
    piece: PackPiece,
    urls: Record<string, string>,
    i: number,
    onDone?: () => void,
  ) => {
    stop()
    const { src, text } = at(piece, urls, i)
    if (!src && !text) return onDone?.()
    speak(src, text, piece.lang || 'en-US', () => onDone?.())
  }

  /** 从第 from 页连着念到最后一页，每翻一页回调一次 onPage */
  const playFrom = (
    piece: PackPiece,
    urls: Record<string, string>,
    from: number,
    onPage: (i: number) => void,
    onDone: () => void,
  ) => {
    stop()
    const gen = genRef.current
    const step = (i: number) => {
      if (gen !== genRef.current) return // 已经被停掉了
      if (i >= piece.pages.length) return onDone()
      onPage(i)
      const { src, text } = at(piece, urls, i)
      if (!src && !text) return step(i + 1) // 这页没声音，跳过别卡住
      speak(src, text, piece.lang || 'en-US', () => {
        if (gen === genRef.current) step(i + 1)
      })
    }
    step(from)
  }

  /**
   * 整本一条音轨：从头念到尾，**和页码完全无关**。
   *
   * 所以它不回调 onPage、调用方也不该在翻页时把它停掉 —— 孩子就是要
   * 一边听一边自己翻页对照（牛津树那批书的音频里还夹着拼读练习，
   * 根本对不上页）。没有这条音轨时直接 onDone，调用方不用先判一遍。
   */
  const playWhole = (piece: PackPiece, urls: Record<string, string>, onDone: () => void) => {
    stop()
    const rel = bookAudioOf(piece)
    const src = rel ? urls[rel] : undefined
    if (!src) return onDone()
    speak(src, undefined, piece.lang || 'en-US', onDone)
  }

  return { playPage, playFrom, playWhole, stop }
}
