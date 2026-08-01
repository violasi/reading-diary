/**
 * 奥特曼立绘是商业角色美术，不入库（见 .gitignore），所以任何一份新 clone
 * 出来的代码都可能没有这些图。缺图时静默降级，别让孩子看到一个碎图标。
 */
import { useState, type ReactNode } from 'react'
import { HERO_NAME, heroImg } from '../data/heroes'

export default function HeroImg({
  className,
  fallback = null,
}: {
  className?: string
  /** 图缺失时顶上来的东西。不给就什么都不显示 */
  fallback?: ReactNode
}) {
  const [failed, setFailed] = useState(false)
  if (failed) return <>{fallback}</>
  return (
    <img
      src={heroImg()}
      alt={HERO_NAME}
      className={className}
      onError={() => setFailed(true)}
    />
  )
}
