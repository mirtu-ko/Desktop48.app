const YI_ZHI_BO_HOST = 'alcdn.hls.xiaoka.tv'

class Tools {
  private static readonly STREAM_PATH_REGEX = /^(http|https):\/\/([^/]+)\/(\d+)/

  /**
   * 将相对路径 / 相对图片路径归一化为 source.48.cn 完整 URL；已是完整 URL 时原样返回
   */
  private static toSourceUrl(path: string): string {
    // 空进空出：空串拼前缀会产出必然 404 的垃圾 URL（头像位碎图的根源）
    if (!path)
      return ''
    if (path.endsWith('.png.png'))
      path = path.replace('.png.png', '.png')
    if (path.includes('http'))
      return path
    return `https://source.48.cn${path}`
  }

  private static readonly DATE_FORMAT_REGEXES: Record<string, RegExp> = {
    'M+': /(M+)/,
    'd+': /(d+)/,
    'h+': /(h+)/,
    'm+': /(m+)/,
    's+': /(s+)/,
    'q+': /(q+)/,
    'S': /(S)/,
  }

  private static readonly YEAR_REGEX = /(y+)/

  /**
   * 将逗号分隔的图片路径转换为完整的URL数组
   * @param picturesStr 逗号分隔的图片路径字符串
   * @returns {string[]} 完整的图片URL数组
   */
  public static pictureUrls(picturesStr: string) {
    // teamLogo 等字段为可选，数据缺失（undefined/null）时返回空数组，
    // 避免 .split 抛错导致整页列表加载失败
    if (!picturesStr)
      return []
    return picturesStr.split(',').map(picture => Tools.toSourceUrl(picture))
  }

  public static sourceUrl(sourcePath: string) {
    return Tools.toSourceUrl(sourcePath)
  }

  public static timeToSecond(time: string): number {
    if (!time) {
      return 0
    }
    const [hours, minutes, seconds] = time.split(':')
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
  }

  public static lyricsParse(lyrics: string) {
    if (!lyrics) {
      console.error('lyrics undefined')
      return []
    }
    const barrages: any[] = []
    const lines = lyrics.split('\n')
    lines.forEach((line: string) => {
      const tmp = line.split(']')
      if (tmp.length > 1) {
        const arr = tmp[1].split('\t')
        barrages.push({
          time: tmp[0].replace('[', ''),
          username: arr[0],
          content: arr[1],
        })
      }
    })
    return barrages
  }

  public static streamPathHandle(streamPath: string, timestamp: number) {
    const date = new Date(timestamp)
    const liveDate = `${date.getFullYear()}${date.getMonth() + 1}${date.getDate()}`
    return streamPath.replace(Tools.STREAM_PATH_REGEX, (pathPrefix, protocol, host) => {
      if (host.toLowerCase() !== YI_ZHI_BO_HOST) {
        return pathPrefix
      }

      return `${protocol}://${host}/${liveDate}`
    })
  }

  /**
   * 秒数 → m:ss（分钟不补零，如 6:05）；曲目总时长 / 迷你播放条进度共用
   */
  public static formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds || 0))
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }

  /**
   * 下载/录制任务文件名：成员名 + 任务开始时间（yyyyMMddhhmm）+ 扩展名。
   * separator 为成员名与时间戳之间的分隔符（录制为空格、回放下载紧连，保持既有命名）；
   * 同场直播同一时刻只允许一个任务，文件名保持分钟精度即可，
   * 跨任务的同名冲突由主进程 Start 前的冲突检测兜底（自动加序号）
   */
  public static taskFilename(realName: string, startTime: number, ext: string, separator = ''): string {
    return `${realName}${separator}${Tools.dateFormat(startTime, 'yyyyMMddhhmm')}.${ext}`
  }

  /**
   * 队伍名展示名：剥掉 TEAM 前缀（TEAM SII → SII）
   */
  public static shortTeamName(teamName: string): string {
    return (teamName || '').replace('TEAM ', '')
  }

  public static dateFormat(timestamp: number, fmt: string): string {
    const date = new Date(timestamp)
    const o: any = {
      'M+': date.getMonth() + 1,
      'd+': date.getDate(),
      'h+': date.getHours(),
      'm+': date.getMinutes(),
      's+': date.getSeconds(),
      'q+': Math.floor((date.getMonth() + 3) / 3),
      'S': date.getMilliseconds(),
    }
    // 年份占位符（如 'yyyy'、'yy'）单独按长度截取
    const yearMatch = Tools.YEAR_REGEX.exec(fmt)
    if (yearMatch) {
      const yStr = yearMatch[1]
      fmt = fmt.replace(yStr, `${date.getFullYear()}`.substring(4 - yStr.length))
    }
    // 其余占位符按 o 表逐项替换
    for (const k in o) {
      const regex = Tools.DATE_FORMAT_REGEXES[k]
      const match = regex.exec(fmt)
      if (match) {
        const matchStr = match[1]
        const replacement = matchStr.length === 1
          ? o[k]
          : (`00${o[k]}`).substring(`${o[k]}`.length)
        fmt = fmt.replace(matchStr, replacement)
      }
    }
    return fmt
  }
}

export default Tools
