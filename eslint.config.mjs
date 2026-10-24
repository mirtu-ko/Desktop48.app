import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: {
    css: true,
    html: true,
    markdown: true,
  },
  vue: true,
  // resources/pocket48/ 是官方 App 抽取的 wasm 签名模块与其生成胶水（见 main/pocket48/pa-sign.ts），
  // 生成物代码风格不可控，不参与 lint；build 为构建产物目录
  ignores: ['build', 'resources/pocket48'],
}, {
  rules: {
    // 恢复严格相等检查，但放行 `!= null`（判空惯用写法，语义上就是“非 null/undefined”）
    'vue/eqeqeq': ['error', 'always', { null: 'ignore' }],
    'eqeqeq': ['error', 'always', { null: 'ignore' }],
    'no-console': ['error', { allow: ['error'] }],
    // v10 新增：调用/三元/嵌套一出现就强制逐项换行（阈值仅管元素个数与行宽），
    // 会把紧凑的单行数组拆散，与全仓库既有风格冲突；只关这一条，其余保持默认
    'antfu/reasonable-newline': 'off',
  },
}, {
  files: [
    'src/main/**/*',
    'src/preload/**/*',
    'src/common/**/*',
  ],
  rules: {
    'node/prefer-global/process': 'off',
  },
})
