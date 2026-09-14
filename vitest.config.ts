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
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
