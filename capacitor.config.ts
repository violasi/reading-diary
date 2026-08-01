import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.family.readingdiary',
  appName: '阅读打卡日记',
  // Capacitor 默认是 www，但 Vite 产物在 dist —— 不写这行会同步到空目录
  webDir: 'dist',
  android: {
    // 孩子端全部按竖屏布局设计，横过来会一团糟
    // （真正锁死靠 AndroidManifest 的 screenOrientation，这里只是不让它自己缩放）
    allowMixedContent: false,
  },
}

export default config
