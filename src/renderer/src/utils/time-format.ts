import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

// utc() 构造器由插件提供：把秒数当作 UTC 偏移，format 直接读时分秒，免手写补零
dayjs.extend(utc)

/**
 * 媒体时长格式化：不足 1 小时显示 mm:ss，超过则 hh:mm:ss。
 * 供 MiniControls 进度段、直播 LIVE 时长段与专辑卡片总时长共用，保证各处观感一致。
 *
 * 非有限值（NaN / Infinity）按 0 处理：直接交给 dayjs.utc 会 format 出
 * 'Invalid Date' 渲染到界面上。注意不能只写 `seconds || 0`——Infinity 是真值，
 * 绕过短路后 Math.floor 仍得 Infinity。
 */
export function formatMediaTime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return dayjs.utc(total * 1000).format(total >= 3600 ? 'HH:mm:ss' : 'mm:ss')
}
