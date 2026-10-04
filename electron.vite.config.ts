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
        // 与 tsconfig.web.json / vitest.config.ts 的 @renderer 目标保持一致。
        '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      },
    },
    plugins: [vue()],
  },
})
