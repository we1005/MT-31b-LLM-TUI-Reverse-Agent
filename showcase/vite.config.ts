import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// 多页站：landing(index) + docs 浏览 + wiki 浏览。base './' 便于任意子路径/根路径部署。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2400, // mermaid 体积大，抬高告警阈
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        docs: resolve(__dirname, 'docs.html'),
        wiki: resolve(__dirname, 'wiki.html'),
        tutorial: resolve(__dirname, 'tutorial.html'),
      },
    },
  },
})
