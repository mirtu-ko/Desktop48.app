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

  it('标题里的文件名非法字符替换成下划线（主进程按路径穿越防御会拒绝斜杠等）', () => {
    const minuteTs = new Date(2026, 8, 5, 2, 3).getTime()
    expect(Tools.taskFilename('4/8班联合公演', minuteTs, 'flv', ' ')).toBe('4_8班联合公演 202609050203.flv')
    expect(Tools.taskFilename('a\\b:c*d?e"f<g>h|i', minuteTs, 'mp4')).toBe('a_b_c_d_e_f_g_h_i202609050203.mp4')
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

describe('tools.toHex（队色归一化）', () => {
  it('裸 HEX 补上 #，已是 # 开头的原样返回', () => {
    expect(Tools.toHex('8FD3F6')).toBe('#8FD3F6')
    expect(Tools.toHex('#8FD3F6')).toBe('#8FD3F6')
    expect(Tools.toHex(' 8FD3F6 ')).toBe('#8FD3F6')
  })

  it('空值返回空串而不是 "#"（"#" 是非法颜色，会把兜底色一并吃掉）', () => {
    expect(Tools.toHex('')).toBe('')
    expect(Tools.toHex('   ')).toBe('')
    expect(Tools.toHex(undefined)).toBe('')
  })
})

describe('tools.colorVarStyle（队色 → 内联 CSS 变量）', () => {
  it('有队色时产出变量对象', () => {
    expect(Tools.colorVarStyle('--tb-color', '8FD3F6')).toEqual({ '--tb-color': '#8FD3F6' })
  })

  it('无队色时返回 undefined，不注入变量（交给 CSS 兜底）', () => {
    expect(Tools.colorVarStyle('--tb-color', '')).toBeUndefined()
    expect(Tools.colorVarStyle('--tb-color', undefined)).toBeUndefined()
  })
})

describe('tools.readableInk（按底色亮度挑前景色）', () => {
  const DARK = '#2b2440'

  it('浅色团体色给深墨：实心药丸上白字会糊成一片', () => {
    expect(Tools.readableInk('#8FD3F6')).toBe(DARK) // SNH48 浅蓝
    expect(Tools.readableInk('#FFBA07')).toBe(DARK) // CKG48 琥珀
    expect(Tools.readableInk('#ABCA14')).toBe(DARK) // GNZ48 黄绿
    expect(Tools.readableInk('#ffffff')).toBe(DARK)
  })

  it('深色团体色给白字', () => {
    expect(Tools.readableInk('#D21217')).toBe('#fff') // CGT48 深红
    expect(Tools.readableInk('#FE2472')).toBe('#fff') // BEJ48 玫红
    expect(Tools.readableInk('#6d5ae0')).toBe('#fff') // 品牌紫
    expect(Tools.readableInk('#000000')).toBe('#fff')
  })

  it('三位简写与裸 HEX 都认（内部先过 toHex）', () => {
    expect(Tools.readableInk('#fff')).toBe(DARK)
    expect(Tools.readableInk('8FD3F6')).toBe(DARK)
    expect(Tools.readableInk('D21217')).toBe('#fff')
  })

  it('认不出颜色时按白字兜底：CSS 变量（如 var(--color-members)）解析不了，而现有变量色都是中深色', () => {
    expect(Tools.readableInk('var(--color-members)')).toBe('#fff')
    expect(Tools.readableInk('')).toBe('#fff')
    expect(Tools.readableInk(undefined)).toBe('#fff')
    expect(Tools.readableInk('rebeccapurple')).toBe('#fff')
  })
})
