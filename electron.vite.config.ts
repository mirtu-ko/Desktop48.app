import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  // main / preload 必须显式声明：electron-vite 只构建「配置里出现过的」target
  main: {
    plugins: [],
  },
  preload: {
    plugins: [],
  },
  renderer: {
    resolve: {
      alias: {
        // 相对本配置文件解析，不用 resolve()：后者相对 CWD，从子目录启动会指到错误位置。
        // 与 tsconfig.web.json / vitest.config.ts 的同名目标保持一致。
        '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
        // 跨树共享层：common（主/渲染共用逻辑）与 preload 的 IPC 契约，免 ../.. 爬树
        '@common': fileURLToPath(new URL('./src/common', import.meta.url)),
        '@preload': fileURLToPath(new URL('./src/preload', import.meta.url)),
      },
    },
    plugins: [vue()],
  },
})
