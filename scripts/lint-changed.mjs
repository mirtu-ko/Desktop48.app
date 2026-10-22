/**
 * 只对改动过的文件跑 ESLint（未暂存 + 已暂存 + 未跟踪），用于日常迭代；
 * 提交前仍应跑一次全量 `npm run lint`。
 *
 * 用 Node 而不是 shell 管道：-z 输出按 NUL 切分，路径含空格或中文也不会错，
 * 且 Windows / macOS / Linux 行为一致。
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const LINTABLE = /\.(?:ts|tsx|vue|mjs|cjs|js|md)$/

function gitNames(args) {
  const result = spawnSync('git', args, { encoding: 'buffer' })
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr.toString('utf8').trim()}`)
  return result.stdout.toString('utf8').split('\0').filter(Boolean)
}

const names = [
  // 已跟踪文件的改动（含已暂存与未暂存；排除删除）
  ...gitNames(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '-z']),
  // 尚未 git add 的新文件
  ...gitNames(['ls-files', '-z', '--others', '--exclude-standard']),
]

const files = [...new Set(names)].filter(file => LINTABLE.test(file))

if (files.length === 0) {
  // 项目 lint 规则禁止 console.log，脚本输出走 stdout
  process.stdout.write('lint:changed: 没有可检查的改动文件\n')
  process.exit(0)
}

process.stdout.write(`lint:changed: ${files.length} 个文件\n`)
const eslint = spawnSync(
  process.execPath,
  ['node_modules/eslint/bin/eslint.js', '--cache', ...files],
  { stdio: 'inherit' },
)
process.exit(eslint.status ?? 1)
