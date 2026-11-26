import type { ExecFileOptions } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import afterPack, { buildWrapperScript } from '../scripts/after-pack.mjs'

/** 包一层 Promise，方便 await 子进程输出的参数回显 */
function execFileAsync(file: string, args: string[], options: ExecFileOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  })
}

const FAKE_BINARY = '#!/bin/true\n# 假 electron 二进制\n'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 造一个刚打完包的产物目录：主可执行文件是假二进制 */
async function makeAppOut(): Promise<string> {
  const appOutDir = await tempDir('desktop48-afterpack-')
  await writeFile(join(appOutDir, 'Desktop48'), FAKE_BINARY, { mode: 0o755 })
  return appOutDir
}

function linuxContext(appOutDir: string) {
  return { electronPlatformName: 'linux', appOutDir, packager: { executableName: 'Desktop48' } }
}

describe('afterPack（产物目录里的真二进制改名为 -bin）', () => {
  it('原位换成包装脚本，真二进制搬到 -bin 且可执行位不变', async () => {
    const appOutDir = await makeAppOut()

    await afterPack(linuxContext(appOutDir))

    expect(await readFile(join(appOutDir, 'Desktop48-bin'), 'utf8')).toBe(FAKE_BINARY)
    const wrapper = join(appOutDir, 'Desktop48')
    expect(await readFile(wrapper, 'utf8')).toContain('# desktop48-launcher-wrapper')
    expect((await stat(wrapper)).mode & 0o777).toBe(0o755)
  })

  it('重复执行是幂等的：不会把包装脚本搬成 -bin 覆盖真二进制', async () => {
    const appOutDir = await makeAppOut()

    await afterPack(linuxContext(appOutDir))
    const wrapperBefore = await readFile(join(appOutDir, 'Desktop48'), 'utf8')
    await afterPack(linuxContext(appOutDir))

    // 第二次若照旧 rename，-bin 会变成包装脚本，exec 自己形成死循环
    expect(await readFile(join(appOutDir, 'Desktop48-bin'), 'utf8')).toBe(FAKE_BINARY)
    expect(await readFile(join(appOutDir, 'Desktop48'), 'utf8')).toBe(wrapperBefore)
  })

  it('非 Linux 平台直接跳过包装脚本，产物保持原样', async () => {
    const appOutDir = await makeAppOut()

    await afterPack({ ...linuxContext(appOutDir), electronPlatformName: 'darwin' })

    expect(await readdir(appOutDir)).toEqual(['Desktop48'])
    expect(await readFile(join(appOutDir, 'Desktop48'), 'utf8')).toBe(FAKE_BINARY)
  })

  it('linux 下在改名为 -bin 之前翻转 Electron fuses，幂等重跑不重复执行', async () => {
    const appOutDir = await makeAppOut()
    const calls: string[] = []
    const context = {
      ...linuxContext(appOutDir),
      packager: {
        executableName: 'Desktop48',
        generateFuseConfig(fuses: Record<string, boolean>) {
          calls.push(`generate:${Object.keys(fuses).length}`)
          return Promise.resolve({ version: '1', ...fuses })
        },
        async addElectronFuses() {
          // 此时真二进制必须还在原位，尚未被替换成 shell 包装脚本
          const content = await readFile(join(appOutDir, 'Desktop48'), 'utf8')
          calls.push(content === FAKE_BINARY ? 'fuses-on-binary' : 'fuses-on-wrapper')
        },
      },
    }

    await afterPack(context)
    await afterPack(context)

    expect(calls).toEqual(['generate:5', 'fuses-on-binary'])
  })

  it('非 Linux 平台也会翻转 Electron fuses', async () => {
    const appOutDir = await makeAppOut()
    const calls: string[] = []
    const context = {
      ...linuxContext(appOutDir),
      electronPlatformName: 'win32',
      packager: {
        executableName: 'Desktop48',
        generateFuseConfig() {
          calls.push('generate')
          return Promise.resolve({ version: '1' })
        },
        addElectronFuses() {
          calls.push('fuses')
          return Promise.resolve()
        },
      },
    }

    await afterPack(context)

    expect(calls).toEqual(['generate', 'fuses'])
  })
})

describe('buildWrapperScript（生成内容）', () => {
  const script = buildWrapperScript('Desktop48-bin')

  it('按脚本自身位置找真二进制，并把用户参数原样透传', () => {
    expect(script.startsWith('#!/bin/sh')).toBe(true)
    expect(script).toContain('HERE="$(dirname "$(readlink -f "$0")")"')
    expect(script).toContain('exec "$HERE/Desktop48-bin" $EXTRA_ARGS "$@"')
  })

  it('不处理 --no-sandbox：electron-builder 的 AppRun 已按 unshare 探测结果决定', () => {
    expect(script).not.toContain('no-sandbox')
    expect(script).not.toContain('APPIMAGE')
  })

  it('按整词识别 --ozone-platform，不做整串子串匹配', () => {
    expect(script).toContain('--ozone-platform|--ozone-platform=*')
    expect(script).not.toContain('case " $* "')
  })
})

describe('包装脚本的实际行为（真跑一遍 sh）', () => {
  /** 包装脚本 + 只回显参数的假二进制 */
  async function runWrapper(args: string[], env: Record<string, string>): Promise<string> {
    const dir = await tempDir('desktop48-wrapper-')
    await writeFile(join(dir, 'Desktop48-bin'), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 })
    const wrapper = join(dir, 'Desktop48')
    await writeFile(wrapper, buildWrapperScript('Desktop48-bin'), { mode: 0o755 })

    const cleanEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !['APPIMAGE', 'SOMMELIER_VERSION', 'SOMMELIER_VM_IDENTIFIER'].includes(key))
        cleanEnv[key] = value
    }

    const stdout = await execFileAsync('sh', [wrapper, ...args], {
      env: { ...cleanEnv, PATH: await shellPath(dir), ...env },
    })
    return stdout.trim()
  }

  /** macOS 的 readlink 没有 -f，补一份等价实现进 PATH */
  async function shellPath(dir: string): Promise<string> {
    if (process.platform !== 'darwin')
      return process.env.PATH ?? '/usr/bin:/bin'
    const binDir = join(dir, '.shell-bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, 'readlink'), `#!/bin/sh
if [ "$1" = "-f" ]; then
  exec python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$2"
fi
exec /usr/bin/readlink "$@"
`, { mode: 0o755 })
    return `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`
  }

  it('crostini 下注入 --ozone-platform=x11', async () => {
    expect(await runWrapper(['--foo'], { SOMMELIER_VERSION: '1.0' })).toBe('--ozone-platform=x11 --foo')
    expect(await runWrapper([], { SOMMELIER_VM_IDENTIFIER: 'borealis' })).toBe('--ozone-platform=x11')
  })

  it('普通 Linux 桌面不加任何额外参数', async () => {
    expect(await runWrapper(['--foo', 'bar'], {})).toBe('--foo bar')
  })

  it('用户自己给了 --ozone-platform 就尊重用户的选择', async () => {
    expect(await runWrapper(['--ozone-platform=wayland'], { SOMMELIER_VERSION: '1.0' })).toBe('--ozone-platform=wayland')
    expect(await runWrapper(['--ozone-platform', 'x11'], { SOMMELIER_VERSION: '1.0' })).toBe('--ozone-platform x11')
  })

  it('参数里含 --ozone-platform 子串（文件名）不算给了开关', async () => {
    expect(await runWrapper(['/tmp/--ozone-platform-notes.txt'], { SOMMELIER_VERSION: '1.0' }))
      .toBe('--ozone-platform=x11 /tmp/--ozone-platform-notes.txt')
  })

  it('appImage 下不追加 --no-sandbox（交给 AppRun 按 unshare 探测）', async () => {
    expect(await runWrapper(['--foo'], { APPIMAGE: '/tmp/Desktop48.AppImage' })).toBe('--foo')
  })
})
