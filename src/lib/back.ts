/**
 * 安卓返回键。
 *
 * WebView 里不接这个键，孩子一按就直接退出 App（或退到上一条历史），
 * 界面上那些「正在录音，真的要离开吗」的保护全被绕过去。
 *
 * 用模块级的 guard 而不是 context：只有阅读页在录音时需要拦一下，
 * 为这一个场景铺一层 provider 不值。
 */
type Guard = () => boolean

let guard: Guard | null = null

/** 返回 true 表示「这一下我处理了」，App 不再往上退 */
export const setBackGuard = (g: Guard | null) => {
  guard = g
}

export const runBackGuard = () => (guard ? guard() : false)
