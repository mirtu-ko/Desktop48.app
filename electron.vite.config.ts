import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'

// 跨树别名。一律相对本配置文件解析，不用 resolve()：后者相对 CWD，从子目录启动会指到错误位置。
// 三个 target 与 tsconfig.node.json / tsconfig.web.json / vitest.config.ts 的同名目标保持一致，
// 因此 main 与 renderer 引用 common / preload 契约时写法完全相同（不爬树）。
const sharedAlias = {
  '@common': fileURLToPath(new URL('./src/common', import.meta.url)),
  '@preload': fileURLToPath(new URL('./src/preload', import.meta.url)),
}

// @renderer 只给渲染层：node 工程的 tsconfig 与 main / preload 两个 target 都不配它，
// 于是「主进程引渲染层」在 typecheck 阶段（类型）与构建阶段（取值）都过不去。
// 这是刻意保留的护栏，不要为「三处写法一致」把它并进 sharedAlias
const alias = {
  ...sharedAlias,
  '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
}

export default defineConfig({
  // main / preload 必须显式声明：electron-vite 只构建「配置里出现过的」target
  main: {
    resolve: { alias: sharedAlias },
    plugins: [],
  },
  preload: {
    resolve: { alias: sharedAlias },
    plugins: [],
  },
  renderer: {
    resolve: {
      alias,
    },
    plugins: [vue()],
  },
})
