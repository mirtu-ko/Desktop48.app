import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: true,
  vue: true,
  ignores: ['node_modules', 'build', 'out', 'dist', '.vitest/'],
}, {
  rules: {
    // 恢复严格相等检查，但放行 `!= null`（判空惯用写法，语义上就是"非 null/undefined"）
    'vue/eqeqeq': ['error', 'always', { null: 'ignore' }],
    'eqeqeq': ['error', 'always', { null: 'ignore' }],
    'no-console': ['error', { allow: ['error'] }],
    'node/prefer-global/process': 'off',
    'n/prefer-global/process': 'off',
  },
})
