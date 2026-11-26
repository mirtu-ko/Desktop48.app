import fs from 'node:fs/promises'
import path from 'node:path'

/** 包装脚本标记：写进 shell 脚本，也用作 afterPack 的幂等判据 */
const WRAPPER_MARKER = '# desktop48-launcher-wrapper'

/** Crostini（ChromeOS 的 Linux 容器）：sommelier 注入的变量，或 cros-guest-tools 的固定路径 */
const CROSTINI_CHECK = '[ -n "$SOMMELIER_VERSION" ] || [ -n "$SOMMELIER_VM_IDENTIFIER" ] || [ -d "/opt/google/cros-containers" ]'

/**
 * 生成同名 shell 包装脚本。
 *
 * 参数必须在命令行上：Chromium 在 main 脚本执行前就解析完 ozone 后端，
 * `appendSwitch` / `relaunch` 都改不动它。`--no-sandbox` 不在此处理 ——
 * electron-builder 的 AppRun 已按 `unshare -Ur true` 实测结果决定是否追加。
 */
export function buildWrapperScript(binaryName) {
  return `#!/bin/sh
${WRAPPER_MARKER}
# 打包时由 scripts/after-pack-linux.mjs 生成，真二进制是同目录的 ${binaryName}
HERE="$(dirname "$(readlink -f "$0")")"
EXTRA_ARGS=""

if ${CROSTINI_CHECK}; then
  # sommelier 的 Wayland 路径不认识缩放与最大化，钉死 X11 才正常；用户自带开关则以用户为准
  OZONE_GIVEN=""
  for arg in "$@"; do
    case "$arg" in
      --ozone-platform|--ozone-platform=*) OZONE_GIVEN=1 ;;
    esac
  done
  [ -n "$OZONE_GIVEN" ] || EXTRA_ARGS="$EXTRA_ARGS --ozone-platform=x11"
fi

exec "$HERE/${binaryName}" $EXTRA_ARGS "$@"
`
}

/**
 * afterPack 钩子：仅 Linux。主可执行文件改名 `<name>-bin`，原位放 shell 包装脚本，
 * 在 Chromium 初始化之前注入参数（Crostini 下 `--ozone-platform=x11`，其余桌面不加）。
 */
export default async function afterPackLinux(context) {
  if (context.electronPlatformName !== 'linux')
    return

  const appOutDir = context.appOutDir
  const executableName = context.packager.executableName
  const wrapperPath = path.join(appOutDir, executableName)
  const binaryName = `${executableName}-bin`
  const binaryPath = path.join(appOutDir, binaryName)

  // 幂等：重复处理同一产物目录时，原位已是包装脚本，再 rename 会覆盖真二进制
  const current = await fs.readFile(wrapperPath, 'utf8').catch(() => '')
  if (current.includes(WRAPPER_MARKER))
    return

  await fs.rename(wrapperPath, binaryPath)
  await fs.writeFile(wrapperPath, buildWrapperScript(binaryName), { mode: 0o755 })
}
