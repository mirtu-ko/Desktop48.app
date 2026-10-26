/** 本地日期键 YYYY-MM-DD；用本地时间而非 UTC，保证「今天」与用户感知一致 */
function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

let currentDay = ''
const enteredRooms = new Set<string>()

/** 判断本次进入是否需要上报，放行时记为已上报 */
export function shouldTrackRoomEnter(userId: number, starName: string): boolean {
  const day = localDayKey(new Date())
  if (day !== currentDay) {
    currentDay = day
    enteredRooms.clear()
  }
  const key = starName || `#${userId}`
  if (enteredRooms.has(key))
    return false
  enteredRooms.add(key)
  return true
}
