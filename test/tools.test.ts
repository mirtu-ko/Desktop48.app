import { describe, expect, it } from 'vitest'
import Tools from '../src/renderer/src/utils/tools'

describe('tools.timeToSecond', () => {
  it('解析 H:M:S 格式', () => {
    expect(Tools.timeToSecond('01:02:03')).toBe(3723)
    expect(Tools.timeToSecond('00:06:05')).toBe(365)
  })

  it('空串返回 0', () => {
    expect(Tools.timeToSecond('')).toBe(0)
  })
})

describe('tools.lyricsParse', () => {
  it('解析 [time]user\tcontent 行', () => {
    const lyrics = '[00:01.00]小明\t你好\n[00:02.50]小红\t晚安'
    expect(Tools.lyricsParse(lyrics)).toEqual([
      { time: '00:01.00', username: '小明', content: '你好' },
      { time: '00:02.50', username: '小红', content: '晚安' },
    ])
  })

  it('无 ] 的行被跳过', () => {
    expect(Tools.lyricsParse('plain line\n[00:01.00]a\tb')).toEqual([
      { time: '00:01.00', username: 'a', content: 'b' },
    ])
  })

  it('空歌词返回空数组', () => {
    expect(Tools.lyricsParse('')).toEqual([])
  })
})

describe('tools.taskFilename', () => {
  it('保持分钟精度文件名', () => {
    // 2026-09-05 02:03（本地时区）
    const minuteTs = new Date(2026, 8, 5, 2, 3).getTime()
    expect(Tools.taskFilename('陈观逸', minuteTs, 'mp4')).toBe('陈观逸202609050203.mp4')
    expect(Tools.taskFilename('陈观逸', minuteTs, 'flv', ' ')).toBe('陈观逸 202609050203.flv')
  })
})

describe('tools.pictureUrls / sourceUrl（图片路径归一化）', () => {
  it('相对路径补 source.48.cn 前缀，已是完整 URL 时原样返回', () => {
    expect(Tools.sourceUrl('/uploads/avatar/a.png')).toBe('https://source.48.cn/uploads/avatar/a.png')
    expect(Tools.sourceUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png')
  })

  it('空值返回空串（空串拼前缀会产出必然 404 的地址，是头像位碎图的根源）', () => {
    expect(Tools.sourceUrl('')).toBe('')
  })

  it('.png.png 重复后缀收敛为单层（相对与绝对路径都收敛）', () => {
    expect(Tools.sourceUrl('/a.png.png')).toBe('https://source.48.cn/a.png')
    expect(Tools.pictureUrls('https://cdn.example.com/a.png.png')).toEqual(['https://cdn.example.com/a.png'])
  })

  it('逗号分隔的多个路径逐个转换', () => {
    expect(Tools.pictureUrls('/a.jpg,https://cdn.example.com/b.jpg')).toEqual([
      'https://source.48.cn/a.jpg',
      'https://cdn.example.com/b.jpg',
    ])
  })

  it('字段缺失（undefined / null / 空串）返回空数组，不抛错', () => {
    expect(Tools.pictureUrls(undefined as unknown as string)).toEqual([])
    expect(Tools.pictureUrls(null as unknown as string)).toEqual([])
    expect(Tools.pictureUrls('')).toEqual([])
  })
})

describe('tools.streamPathHandle（一直播 HLS 路径日期重写）', () => {
  // 2026-09-05：路径首段换成 2026+9+5（月日不补零，与一直播下发的目录格式一致）
  const sept = new Date(2026, 8, 5, 10, 0, 0).getTime()
  const dec = new Date(2026, 11, 25, 10, 0, 0).getTime()

  it('命中一直播域名时重写路径首段为直播日期', () => {
    expect(Tools.streamPathHandle('https://alcdn.hls.xiaoka.tv/12345/abc/index.m3u8', sept))
      .toBe('https://alcdn.hls.xiaoka.tv/202695/abc/index.m3u8')
    // 两位数月日直接拼接，不补零
    expect(Tools.streamPathHandle('https://alcdn.hls.xiaoka.tv/12345/abc/index.m3u8', dec))
      .toBe('https://alcdn.hls.xiaoka.tv/20261225/abc/index.m3u8')
  })

  it('host 大小写不敏感，重写时保留原始大小写', () => {
    expect(Tools.streamPathHandle('https://ALCDN.HLS.XIAOKA.TV/12345/a.m3u8', sept))
      .toBe('https://ALCDN.HLS.XIAOKA.TV/202695/a.m3u8')
  })

  it('其他域名原样返回（48 系自身 CDN 的路径不能被动）', () => {
    const path = 'https://alcdn.live.48.cn/12345/live.flv'
    expect(Tools.streamPathHandle(path, sept)).toBe(path)
    expect(Tools.streamPathHandle('rtmp://alcdn.live.48.cn/live/stream', sept))
      .toBe('rtmp://alcdn.live.48.cn/live/stream')
  })

  it('路径首段不是数字时不匹配，原样返回', () => {
    const path = 'https://alcdn.hls.xiaoka.tv/live/abc.m3u8'
    expect(Tools.streamPathHandle(path, sept)).toBe(path)
    expect(Tools.streamPathHandle('', sept)).toBe('')
  })
})

describe('tools.formatDuration（曲目时长 m:ss）', () => {
  it('分钟不补零、秒补零', () => {
    expect(Tools.formatDuration(0)).toBe('0:00')
    expect(Tools.formatDuration(9)).toBe('0:09')
    expect(Tools.formatDuration(65)).toBe('1:05')
    expect(Tools.formatDuration(600)).toBe('10:00')
  })

  it('超过 1 小时继续按分钟累计（曲目不进位到时）', () => {
    // 与 formatMediaTime 的分工：这里是曲目总时长，61 分钟就是 61:01
    expect(Tools.formatDuration(3661)).toBe('61:01')
  })

  it('小数向下取整', () => {
    expect(Tools.formatDuration(12.9)).toBe('0:12')
  })

  it('负数与非法值（NaN）按 0 处理', () => {
    expect(Tools.formatDuration(-5)).toBe('0:00')
    expect(Tools.formatDuration(Number.NaN)).toBe('0:00')
  })
})

describe('tools.shortTeamName（队伍展示名）', () => {
  it('剥掉 TEAM 前缀', () => {
    expect(Tools.shortTeamName('TEAM SII')).toBe('SII')
    expect(Tools.shortTeamName('TEAM NII')).toBe('NII')
  })

  it('无前缀原样返回；空值返回空串而非抛错', () => {
    expect(Tools.shortTeamName('SII')).toBe('SII')
    expect(Tools.shortTeamName('')).toBe('')
    expect(Tools.shortTeamName(undefined as unknown as string)).toBe('')
  })
})

describe('tools.normalizeUserId（成员键归一化）', () => {
  it('number 原样返回，数字字符串解析成 number', () => {
    expect(Tools.normalizeUserId(9001)).toBe(9001)
    expect(Tools.normalizeUserId('9001')).toBe(9001)
    expect(Tools.normalizeUserId(' 9001 ')).toBe(9001)
  })

  it('脏值与空值判为 NaN，不截断成数字误命中别人', () => {
    // parseInt('123abc') 会得到 123 —— 必须判为无效
    expect(Tools.normalizeUserId('123abc')).toBeNaN()
    expect(Tools.normalizeUserId('')).toBeNaN()
    expect(Tools.normalizeUserId('   ')).toBeNaN()
    expect(Tools.normalizeUserId(undefined)).toBeNaN()
    expect(Tools.normalizeUserId(null)).toBeNaN()
  })
})
