import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      // 引用 ./logger 或 ../logger 的主进程模块，logger 在模块求值期就调用
      // electron 的 app.getPath('userData')，纯 Node 测试环境无法加载 → 替换为无副作用 stub
      {
        find: /^(\.\/|\.\.\/)logger$/,
        replacement: fileURLToPath(new URL('./test/stubs/logger.ts', import.meta.url)),
      },
      // 渲染层内部一律从 @renderer/... 引用（见 electron.vite.config.ts 的
      // renderer.resolve.alias）。缺了它，任何 composables / services 模块都加载不起来，
      // 渲染层就永远测不到 —— 两处别名必须保持一致
      {
        find: '@renderer',
        replacement: fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      },
      // 跨树共享层（与 electron.vite.config.ts 保持一致）：common 会被渲染层模块
      // 运行时引入（float-window/log/app-config 等），必须可解析；preload 契约虽
      // 只被 import type（编译期擦除），一并配上免得将来出现运行时引用时踩坑
      {
        find: '@common',
        replacement: fileURLToPath(new URL('./src/common', import.meta.url)),
      },
      {
        find: '@preload',
        replacement: fileURLToPath(new URL('./src/preload', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
