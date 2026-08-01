import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // 相对路径：部署到任何静态托管的任何子路径都不会白屏。
  // 没有路由库、URL 恒为根，所以相对路径是安全的。
  base: './',
  plugins: [react(), tailwindcss()],
  server: { port: 5181 },
})
