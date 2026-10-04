import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPathInAllowedRoots } from '../src/main/allowed-path'

const ROOTS = ['/Users/z/Downloads', '/Users/z/Movies']

describe('isPathInAllowedRoots（openPath 路径白名单）', () => {
  it('放行根目录自身与其下的文件 / 子目录', () => {
    expect(isPathInAllowedRoots('/Users/z/Downloads', ROOTS)).toBe(true)
    expect(isPathInAllowedRoots('/Users/z/Downloads/a.mp4', ROOTS)).toBe(true)
    expect(isPathInAllowedRoots('/Users/z/Downloads/sub/dir/a.mp4', ROOTS)).toBe(true)
  })

  it('命中任一白名单根目录即可放行', () => {
    expect(isPathInAllowedRoots('/Users/z/Movies/a.mp4', ROOTS)).toBe(true)
  })

  it('拒绝白名单之外的路径', () => {
    expect(isPathInAllowedRoots('/etc/passwd', ROOTS)).toBe(false)
    expect(isPathInAllowedRoots('/Users/z/Desktop/a.mp4', ROOTS)).toBe(false)
  })

  it('必须比较到分隔符边界：同前缀的兄弟目录不算命中', () => {
    expect(isPathInAllowedRoots('/Users/z/Downloads_backup/a.mp4', ROOTS)).toBe(false)
    expect(isPathInAllowedRoots('/Users/z/Downloads2/a.mp4', ROOTS)).toBe(false)
  })

  it('根目录带尾部分隔符也命中', () => {
    expect(isPathInAllowedRoots('/Users/z/Downloads/a.mp4', ['/Users/z/Downloads/'])).toBe(true)
  })

  it('先解析成绝对路径再比较：相对路径与 .. 都绕不出去', () => {
    expect(isPathInAllowedRoots('a.mp4', [process.cwd()])).toBe(true)
    expect(isPathInAllowedRoots(path.join(process.cwd(), 'sub', 'a.mp4'), [process.cwd()])).toBe(true)
    expect(isPathInAllowedRoots('../outside.mp4', [process.cwd()])).toBe(false)
  })

  it('大小写敏感分支：大小写不一致不算命中', () => {
    // 显式传 false，不依赖第三参默认值：默认值是 process.platform === 'win32'，
    // 在 Windows 上会让本用例必然失败，且掩盖「大小写敏感」这一安全相关分支的真实覆盖
    expect(isPathInAllowedRoots('/users/z/downloads/a.mp4', ROOTS, false)).toBe(false)
  })

  it('caseInsensitive 打开时转小写后比较（Windows 分支）', () => {
    expect(isPathInAllowedRoots('/Users/Z/Downloads/A.MP4', ['/users/z/downloads'], true)).toBe(true)
    // 开关只影响大小写，不放宽边界判定
    expect(isPathInAllowedRoots('/Users/Z/Downloads_backup/A.MP4', ['/users/z/downloads'], true)).toBe(false)
  })

  it('空根目录被忽略（否则 path.resolve("") 会把当前工作目录变成放行根）', () => {
    expect(isPathInAllowedRoots(path.join(process.cwd(), 'a.mp4'), [''])).toBe(false)
  })
})
