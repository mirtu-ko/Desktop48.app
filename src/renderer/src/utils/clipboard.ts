/**
 * 剪贴板写入（渲染层）。
 *
 * 窗口页与浮窗页都是安全上下文（dev 的 localhost、打包后的 file://），
 * 主路径用 navigator.clipboard；被权限拒绝或环境不支持时退回 textarea + execCommand。
 */

/** 兜底路径：临时 textarea 选中后 execCommand('copy')，用完立即移除（留在 DOM 里会抢焦点） */
function legacyCopy(value: string): boolean {
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  // 不能 display:none / visibility:hidden——不可见元素无法被选中，execCommand 会失败
  area.style.position = 'fixed'
  area.style.top = '-9999px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  }
  catch {
    ok = false
  }
  document.body.removeChild(area)
  return ok
}

/**
 * 复制纯文本；返回是否成功，调用方据此给成功 / 失败提示（不静默）。
 * 空白内容直接判失败：复制空串对用户等于「按钮坏了」。
 */
export async function copyText(text: string): Promise<boolean> {
  const value = text.trim()
  if (!value)
    return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  }
  catch {
    // 权限被拒 / 窗口失焦时继续走兜底
  }
  return legacyCopy(value)
}
