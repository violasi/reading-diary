/**
 * 念一页：有真人音就放，没有就用系统 TTS 兜底。
 * 阅读页（关 1/关 2）和复习页都用这一份，避免两处逻辑各自跑偏。
 */
import { useEffect, useRef } from 'react'

export function usePagePlayer(lang = 'en-US') {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!audioRef.current) audioRef.current = new Audio()
  // 取消后旧回调还可能触发（TTS 尤其），换代号作废掉
  const genRef = useRef(0)

  // 离开时一定要停掉音频和朗读，否则会在后台继续响
  useEffect(() => {
    const a = audioRef.current!
    return () => {
      a.pause()
      a.src = ''
      window.speechSynthesis?.cancel()
    }
  }, [])

  const stop = () => {
    genRef.current++
    audioRef.current!.pause()
    window.speechSynthesis?.cancel()
  }

  /** src 是真人音的 object URL，没有就退回用 text 朗读 */
  const play = (src: string | undefined, text: string | undefined, onDone: () => void) => {
    const a = audioRef.current!
    const gen = genRef.current
    const guarded = () => {
      if (gen === genRef.current) onDone()
    }
    if (src) {
      a.pause()
      a.src = src
      a.onended = guarded
      a.onerror = guarded
      void a.play().catch(guarded)
      return
    }
    const synth = window.speechSynthesis
    if (!text || !synth) return onDone()
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang
    u.rate = 0.8 // 给孩子跟读，慢一点
    u.onend = guarded
    u.onerror = guarded
    synth.speak(u)
  }

  return { play, stop }
}
