/**
 * 录音。给孩子用的极简约定：点一次开始、点一次结束，不用长按
 * （长按对小手不可靠，读长句必松手）。
 *
 * 录音中同时算实时音量，用来给奥特曼能量槽充能 —— 这是给孩子
 *「麦克风真的在听」的确认，否则他会一直回头问大人。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** 按优先级挑一个浏览器支持的编码。Android WebView 首选 opus，体积最小 */
const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const t of CANDIDATES) if (MediaRecorder.isTypeSupported(t)) return t
  return undefined // 交给浏览器自己决定
}

export type RecState = 'idle' | 'recording' | 'done'

export interface Recorder {
  state: RecState
  /** 0~1，实时音量，驱动能量槽 */
  level: number
  seconds: number
  blob: Blob | null
  error: string | null
  start: () => void
  stop: () => void
  reset: () => void
}

const LEVEL_FPS_MS = 90 // 能量槽不需要 60fps，压到 ~11fps 省掉大量重渲染

export function useRecorder(): Recorder {
  const [state, setState] = useState<RecState>('idle')
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)

  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const levelRef = useRef(0)
  const timerRef = useRef(0)

  /** 彻底收摊：不释放 track，安卓状态栏的录音标识会一直亮着 */
  const teardown = useCallback(() => {
    clearInterval(levelRef.current)
    clearInterval(timerRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
    recRef.current = null
    setLevel(0)
  }, [])

  useEffect(() => teardown, [teardown])

  const start = useCallback(async () => {
    setError(null)
    setBlob(null)
    setSeconds(0)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream

      const mimeType = pickMimeType()
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recRef.current = rec
      const chunks: BlobPart[] = []
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data)
      }
      rec.onstop = () => {
        const out = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        teardown()
        if (out.size === 0) {
          setError('没录到声音，再试一次？')
          setState('idle')
        } else {
          setBlob(out)
          setState('done')
        }
      }
      rec.onerror = () => {
        teardown()
        setError('录音出错了，再试一次？')
        setState('idle')
      }

      // 实时音量
      const ctx = new AudioContext()
      ctxRef.current = ctx
      // AudioContext 是在 await 之后建的，用户手势已过期，会是 suspended 状态 ——
      // 不 resume 的话 analyser 永远读到静音，能量槽就不动了
      if (ctx.state === 'suspended') await ctx.resume()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      const src = ctx.createMediaStreamSource(stream)
      src.connect(analyser)
      // analyser 不接到 destination 时，部分浏览器不会把数据拉过来。
      // 接一个零增益节点到 destination：保证被拉取，又不会把孩子的声音放出来
      const mute = ctx.createGain()
      mute.gain.value = 0
      analyser.connect(mute).connect(ctx.destination)
      const buf = new Uint8Array(analyser.fftSize)
      // 用 setInterval 而不是 requestAnimationFrame：能量槽只需要 ~11fps，
      // rAF 没有好处，而且页面一旦被判为不可见 rAF 会被完全暂停、槽会冻住
      levelRef.current = window.setInterval(() => {
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (const v of buf) {
          const d = (v - 128) / 128
          sum += d * d
        }
        // rms 通常远小于 1，放大后夹到 0~1，让能量槽看起来有反应
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
      }, LEVEL_FPS_MS)

      timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000)

      rec.start(200) // 分片给数据，避免整段丢失
      setState('recording')
    } catch (e) {
      teardown()
      const name = (e as DOMException)?.name
      setError(
        name === 'NotAllowedError'
          ? '需要允许使用麦克风才能录音'
          : name === 'NotFoundError'
            ? '没找到麦克风'
            : '打不开麦克风，再试一次？',
      )
      setState('idle')
    }
  }, [teardown])

  const stop = useCallback(() => {
    const rec = recRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    else {
      teardown()
      setState('idle')
    }
  }, [teardown])

  const reset = useCallback(() => {
    setBlob(null)
    setSeconds(0)
    setError(null)
    setState('idle')
  }, [])

  return { state, level, seconds, blob, error, start, stop, reset }
}
