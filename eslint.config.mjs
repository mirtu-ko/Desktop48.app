import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: {
    css: true,
    html: true,
    markdown: true,
  },
  vue: true,
  ignores: ['build'],
}, {
  rules: {
    // 恢复严格相等检查，但放行 `!= null`（判空惯用写法，语义上就是“非 null/undefined”）
    'vue/eqeqeq': ['error', 'always', { null: 'ignore' }],
    'eqeqeq': ['error', 'always', { null: 'ignore' }],
    'no-console': ['error', { allow: ['error'] }],
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
