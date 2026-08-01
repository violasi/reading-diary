/**
 * 蝴蝶 / 鱼 / 能量 / 星星 —— 全部内联 SVG。
 * 不用 emoji：各安卓版本的系统字体会让 emoji 长得不一样、也上不了我们的配色。
 */
type P = { className?: string }

export const Butterfly = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <g fill="currentColor">
      <path d="M15 10s-9-8-11-2c-2 6 5 8 11 8z" />
      <path d="M17 10s9-8 11-2c2 6-5 8-11 8z" />
      <path d="M15 17s-8 1-9 6c-1 5 6 4 9-1z" />
      <path d="M17 17s8 1 9 6c1 5-6 4-9-1z" />
      <ellipse cx="16" cy="16" rx="1.5" ry="8.5" />
    </g>
    <g stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round">
      <path d="M16 8.5 12.5 4.5" />
      <path d="M16 8.5 19.5 4.5" />
    </g>
  </svg>
)

export const Fish = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <g fill="currentColor">
      <path d="M27 16s-4.5-7.5-11.5-7.5S6.5 11.5 5.5 16c1 4.5 3 7.5 10 7.5S27 16 27 16z" />
      <path d="M5.5 16 .8 10.8v10.4z" />
    </g>
    <circle cx="21.5" cy="13.8" r="1.4" fill="#fff" />
  </svg>
)

export const Bolt = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <path fill="currentColor" d="M18.5 2 7 18h7l-2.5 12L25 13h-7.5z" />
  </svg>
)

export const Star = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <path
      fill="currentColor"
      d="M16 2.5l4.2 8.9 9.8 1.3-7.2 6.7 1.8 9.7-8.6-4.7-8.6 4.7 1.8-9.7L2 12.7l9.8-1.3z"
    />
  </svg>
)

export const Play = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <path fill="currentColor" d="M9 5.5v21l18-10.5z" />
  </svg>
)

/** 摊开的书，给「读过的书」用 */
export const Book = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <path
      fill="currentColor"
      d="M16 7.5C13.5 5.6 10.4 5 6.5 5.4A1.5 1.5 0 005 6.9v17a1.5 1.5 0 001.8 1.5c3.3-.6 6.2-.2 8.2 1.4a1 1 0 002 0c2-1.6 4.9-2 8.2-1.4A1.5 1.5 0 0027 23.9v-17a1.5 1.5 0 00-1.5-1.5C21.6 5 18.5 5.6 16 7.5zm-1 15.9c-1.9-1-4.2-1.3-7-1.1V8.2c3.1-.2 5.4.3 7 1.6zm2 0V9.8c1.6-1.3 3.9-1.8 7-1.6v14.1c-2.8-.2-5.1.1-7 1.1z"
    />
  </svg>
)

export const Pause = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <path fill="currentColor" d="M8 5h6v22H8zM18 5h6v22h-6z" />
  </svg>
)
