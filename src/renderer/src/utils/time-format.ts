import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

// utc() 构造器由插件提供：把秒数当作 UTC 偏移，format 直接读时分秒，免手写补零
dayjs.extend(utc)

/**
 * 媒体时长格式化：不足 1 小时显示 mm:ss，超过则 hh:mm:ss。
 * MiniControls 进度段与直播 LIVE 时长段共用，保证两条胶囊观感一致。
 */
export function formatMediaTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return dayjs.utc(total * 1000).format(total >= 3600 ? 'HH:mm:ss' : 'mm:ss')
}
