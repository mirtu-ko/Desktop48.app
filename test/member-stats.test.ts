import { describe, expect, it } from 'vitest'
import {
  birthMonthStats,
  birthplaceRegion,
  birthplaceStats,
  bloodTypeStats,
  canonicalMembers,
  constellationStats,
  groupStats,
  heightBucketStats,
  heightRanking,
  isHonoraryMember,
  joinYearStats,
  parseHeight,
  parsePeriod,
  periodOrder,
  periodStats,
  scopeMembers,
  STATS_ALL_SCOPE,
  STATS_STATUS_ALL,
  statsOverview,
  statusMembers,
  teamStats,
  zodiacStats,
} from '../src/renderer/src/utils/member-stats'
import { makeMember } from './fixtures/member'

describe('canonicalMembers（统计前先收敛成一人一条）', () => {
  it('剔除兼任镜像卡：兼任记录与本人共用 userId，留着会把同一个人算两遍', () => {
    const list = [
      makeMember({ realName: '甲', userId: 1 }),
      makeMember({ realName: '甲', userId: 1, adjunctId: 77 }),
    ]
    expect(canonicalMembers(list).map(member => member.realName)).toEqual(['甲'])
  })

  it('同一 userId 只保留首条', () => {
    const list = [
      makeMember({ realName: '甲', userId: 1 }),
      makeMember({ realName: '甲（重复）', userId: 1 }),
    ]
    expect(canonicalMembers(list).map(member => member.realName)).toEqual(['甲'])
  })

  it('没有 userId 的官网补充成员原样保留（无从去重）', () => {
    const list = [makeMember({ realName: '甲', sid: '1' }), makeMember({ realName: '乙', sid: '2' })]
    expect(canonicalMembers(list)).toHaveLength(2)
  })
})

describe('constellationStats（星座分布）', () => {
  const list = [
    makeMember({ realName: '甲', constellation: '天秤座' }),
    makeMember({ realName: '乙', constellation: '天秤' }),
    makeMember({ realName: '丙', constellation: '双鱼座' }),
    makeMember({ realName: '丁', constellation: '' }),
    makeMember({ realName: '戊', constellation: '银河座' }),
  ]

  it('去掉「座」后缀后合并计数，按人数降序', () => {
    expect(constellationStats(list)).toEqual([
      { label: '天秤', count: 2 },
      { label: '双鱼', count: 1 },
    ])
  })

  it('非星座的脏值被丢弃，空值不计入', () => {
    expect(constellationStats(list).some(item => item.label === '银河')).toBe(false)
  })

  it('「魔羯」归一到「摩羯」：上游两种写法混发，不归一会让摩羯座凭空少掉一大半', () => {
    const mixed = [
      makeMember({ realName: '甲', constellation: '摩羯座' }),
      makeMember({ realName: '乙', constellation: '魔羯座' }),
      makeMember({ realName: '丙', constellation: '魔羯' }),
    ]
    expect(constellationStats(mixed)).toEqual([{ label: '摩羯', count: 3 }])
  })
})

describe('joinYearStats（入团年份分布）', () => {
  it('三种日期写法都取到年份，缺失的不计入，结果按年份升序', () => {
    const list = [
      makeMember({ realName: '丙', joinTime: '2020-01-01' }),
      makeMember({ realName: '甲', joinTime: '2016-09-15' }),
      makeMember({ realName: '乙', joinTime: '2016年9月15日' }),
      makeMember({ realName: '丁', joinTime: '' }),
    ]
    expect(joinYearStats(list)).toEqual([
      { label: '2016', count: 2 },
      { label: '2020', count: 1 },
    ])
  })
})

describe('scopeMembers（按分团范围筛人）', () => {
  const list = [
    makeMember({ realName: '甲', groupId: 10 }),
    makeMember({ realName: '乙', groupId: '10' }),
    makeMember({ realName: '丙', groupId: 12 }),
    makeMember({ realName: '丁' }),
  ]

  it('key 为 0 与空串都表示全库（GroupTabs 第一项的 key 直接当哨兵值）', () => {
    expect(scopeMembers(list, STATS_ALL_SCOPE)).toHaveLength(4)
    expect(scopeMembers(list, '')).toHaveLength(4)
  })

  it('按 groupId 精确匹配，数字与字符串写法都能命中', () => {
    expect(scopeMembers(list, '10').map(member => member.realName)).toEqual(['甲', '乙'])
    expect(scopeMembers(list, '12').map(member => member.realName)).toEqual(['丙'])
  })

  it('groupId 缺失的成员只出现在全库范围，不会被塞进任何分团', () => {
    expect(scopeMembers(list, '11')).toHaveLength(0)
  })
})

describe('statusMembers（按状态口径筛人）', () => {
  const list = [
    makeMember({ realName: '在团甲', status: 1 }),
    makeMember({ realName: '暂休乙', status: 2 }),
    makeMember({ realName: '退团丙', status: 3 }),
  ]

  it('「全部」原样返回：暂休 / 退团都留着', () => {
    expect(statusMembers(list, STATS_STATUS_ALL)).toHaveLength(3)
  })

  it('「在团」只留 status === 1', () => {
    expect(statusMembers(list, 'active').map(member => member.realName)).toEqual(['在团甲'])
  })

  it('与 scopeMembers 正交：范围 × 状态可任意组合，且必须先过 canonicalMembers', () => {
    // 兼任镜像卡与本人共用 userId，留着会让「在团」把同一个人算两遍
    const mixed = [
      makeMember({ realName: '甲', userId: 1, groupId: 10 }),
      makeMember({ realName: '甲', userId: 1, groupId: 12, adjunctId: 77, status: 2 }),
      makeMember({ realName: '乙', userId: 2, groupId: 10, status: 2 }),
      makeMember({ realName: '丙', userId: 3, groupId: 12 }),
    ]
    const canonical = canonicalMembers(mixed)
    expect(statusMembers(scopeMembers(canonical, '10'), 'active').map(member => member.realName)).toEqual(['甲'])
    expect(statusMembers(scopeMembers(canonical, '10'), STATS_STATUS_ALL).map(member => member.realName)).toEqual(['甲', '乙'])
    expect(statusMembers(scopeMembers(canonical, '12'), 'active').map(member => member.realName)).toEqual(['丙'])
  })

  it('「在团」一并排掉荣誉毕业生 / 明星殿堂（它们在上游同样是 status = 1）', () => {
    const list = [
      makeMember({ realName: '现役甲', status: 1, teamName: 'TEAM SII' }),
      makeMember({ realName: '荣誉乙', status: 1, teamName: '荣誉毕业生' }),
      makeMember({ realName: '殿堂丙', status: 1, teamName: '明星殿堂' }),
    ]
    expect(statusMembers(list, 'active').map(member => member.realName)).toEqual(['现役甲'])
    // 「全部」口径不动：她们仍是档案的一部分，只是不算「在团」
    expect(statusMembers(list, STATS_STATUS_ALL)).toHaveLength(3)
  })
})

describe('isHonoraryMember（荣誉毕业生 / 明星殿堂）', () => {
  it('按队伍名命中，与团体无关（SNH48 与 GNZ48 各有一支荣誉毕业生队）', () => {
    expect(isHonoraryMember(makeMember({ realName: '甲', groupName: 'SNH48', teamName: '荣誉毕业生' }))).toBe(true)
    expect(isHonoraryMember(makeMember({ realName: '甲', groupName: 'GNZ48', teamName: '荣誉毕业生' }))).toBe(true)
    expect(isHonoraryMember(makeMember({ realName: '甲', groupName: 'SNH48', teamName: '明星殿堂' }))).toBe(true)
  })

  it('⚠️ 判据只看队伍名：团体名是「明星殿堂」但队伍不是的，仍按普通成员处理', () => {
    // 成员树会把 groupId 19 别名归并进 SNH48，合并结果里没有 groupName === '明星殿堂' 的人；
    // 这条用来钉住「不许顺手拿 groupName 当判据」——那会让判据在真实数据上恒不命中
    expect(isHonoraryMember(makeMember({ realName: '甲', groupName: '明星殿堂', teamName: 'TEAM SII' }))).toBe(false)
  })

  it('普通队伍 / 空队伍都不误伤，比较前去掉空白', () => {
    expect(isHonoraryMember(makeMember({ realName: '甲', teamName: 'TEAM SII' }))).toBe(false)
    expect(isHonoraryMember(makeMember({ realName: '甲', teamName: '' }))).toBe(false)
    expect(isHonoraryMember(makeMember({ realName: '甲' }))).toBe(false)
    expect(isHonoraryMember(makeMember({ realName: '甲', teamName: ' 荣誉毕业生 ' }))).toBe(true)
  })
})

describe('periodOrder（期数名 → 序号）', () => {
  it('认中文数字，含十位组合', () => {
    expect(periodOrder('一期生')).toBe(1)
    expect(periodOrder('九期生')).toBe(9)
    expect(periodOrder('十期生')).toBe(10)
    expect(periodOrder('十二期生')).toBe(12)
    expect(periodOrder('二十期生')).toBe(20)
    expect(periodOrder('二十三期生')).toBe(23)
  })

  it('阿拉伯数字写法也认', () => {
    expect(periodOrder('1期生')).toBe(1)
    expect(periodOrder('13期生')).toBe(13)
  })

  it('认不出时排到末尾（MAX_SAFE_INTEGER），不会插到一期生前面', () => {
    expect(periodOrder('研修生')).toBe(Number.MAX_SAFE_INTEGER)
    expect(periodOrder('')).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('parsePeriod（「团体 + 期数」拆解）', () => {
  it('按首个空白拆成团体与期数两段', () => {
    expect(parsePeriod('SNH48 一期生')).toEqual({ group: 'SNH48', name: '一期生', order: 1 })
    expect(parsePeriod('GNZ48 十二期生')).toEqual({ group: 'GNZ48', name: '十二期生', order: 12 })
  })

  it('没有团体前缀时整串当期数名（接口的旧写法）', () => {
    expect(parsePeriod('一期生')).toEqual({ group: '', name: '一期生', order: 1 })
  })

  it('空值给出排到末尾的空条目', () => {
    expect(parsePeriod('')).toEqual({ group: '', name: '', order: Number.MAX_SAFE_INTEGER })
    expect(parsePeriod(undefined).name).toBe('')
  })
})

describe('periodStats（期数分布）', () => {
  it('按期数序号升序，而不是按人数降序 —— 期数是时间轴，人多的一期不该插到前面', () => {
    const list = [
      makeMember({ realName: '甲', periodName: '二期生' }),
      makeMember({ realName: '乙', periodName: '二期生' }),
      makeMember({ realName: '丙', periodName: '二期生' }),
      makeMember({ realName: '丁', periodName: '一期生' }),
      makeMember({ realName: '戊', periodName: '' }),
    ]
    expect(periodStats(list)).toEqual([
      { label: '一期生', count: 1 },
      { label: '二期生', count: 3 },
    ])
  })

  it('跨团时保留团体前缀：各团的「一期生」是不同年代的不同批人，糊成一条会误导', () => {
    const list = [
      makeMember({ realName: '甲', periodName: 'SNH48 一期生' }),
      makeMember({ realName: '乙', periodName: 'GNZ48 一期生' }),
      makeMember({ realName: '丙', periodName: 'GNZ48 二期生' }),
    ]
    expect(periodStats(list)).toEqual([
      { label: 'GNZ48 一期生', count: 1 },
      { label: 'GNZ48 二期生', count: 1 },
      { label: 'SNH48 一期生', count: 1 },
    ])
  })

  it('团体之间按人数降序，而不是按团名字母序 —— 主团不该被沉到列表最底下', () => {
    const list = [
      makeMember({ realName: '甲', periodName: 'SNH48 一期生' }),
      makeMember({ realName: '乙', periodName: 'SNH48 二期生' }),
      makeMember({ realName: '丙', periodName: 'SNH48 三期生' }),
      makeMember({ realName: '丁', periodName: 'BEJ48 一期生' }),
    ]
    expect(periodStats(list).map(item => item.label)).toEqual([
      'SNH48 一期生',
      'SNH48 二期生',
      'SNH48 三期生',
      'BEJ48 一期生',
    ])
  })

  it('单团范围剥掉团体前缀：同一团里前缀纯属重复，剥掉后标签才看得全', () => {
    const list = [
      makeMember({ realName: '甲', periodName: 'SNH48 一期生' }),
      makeMember({ realName: '乙', periodName: 'SNH48 一期生' }),
      makeMember({ realName: '丙', periodName: 'SNH48 三期生' }),
    ]
    expect(periodStats(list)).toEqual([
      { label: '一期生', count: 2 },
      { label: '三期生', count: 1 },
    ])
  })
})

describe('groupStats / teamStats（分团与队伍分布）', () => {
  it('分团按人数降序', () => {
    const list = [
      makeMember({ realName: '甲', groupName: 'SNH48' }),
      makeMember({ realName: '乙', groupName: 'SNH48' }),
      makeMember({ realName: '丙', groupName: 'GNZ48' }),
    ]
    expect(groupStats(list)).toEqual([
      { label: 'SNH48', count: 2 },
      { label: 'GNZ48', count: 1 },
    ])
  })

  it('队伍名去掉 TEAM 前缀；跨团时补团体前缀，避免 SII / G 这类队名与他团重名', () => {
    const list = [
      makeMember({ realName: '甲', groupName: 'SNH48', teamName: 'TEAM SII' }),
      makeMember({ realName: '乙', groupName: 'SNH48', teamName: 'TEAM SII' }),
      makeMember({ realName: '丙', groupName: 'GNZ48', teamName: 'TEAM SII' }),
    ]
    expect(teamStats(list)).toEqual([
      { label: 'SNH48 SII', count: 2 },
      { label: 'GNZ48 SII', count: 1 },
    ])
  })

  it('单团范围不补前缀；没有队伍的成员不计入', () => {
    const list = [
      makeMember({ realName: '甲', groupName: 'SNH48', teamName: 'TEAM SII' }),
      makeMember({ realName: '乙', groupName: 'SNH48', teamName: '' }),
    ]
    expect(teamStats(list)).toEqual([{ label: 'SII', count: 1 }])
  })

  it('队伍名与团体名相同时不重复补前缀（IDFT / 海外练习生 这类单人团体）', () => {
    const list = [
      makeMember({ realName: '甲', groupName: 'SNH48', teamName: 'TEAM SII' }),
      makeMember({ realName: '乙', groupName: 'IDFT', teamName: 'IDFT' }),
      makeMember({ realName: '丙', groupName: 'IDFT', teamName: 'IDFT' }),
    ]
    expect(teamStats(list)).toEqual([
      { label: 'IDFT', count: 2 },
      { label: 'SNH48 SII', count: 1 },
    ])
  })
})

describe('bloodTypeStats（血型分布）', () => {
  it('取开头的字母串，「O型」「o」「AB」都归一', () => {
    const list = [
      makeMember({ realName: '甲', bloodType: 'O型' }),
      makeMember({ realName: '乙', bloodType: 'o' }),
      makeMember({ realName: '丙', bloodType: 'AB' }),
      makeMember({ realName: '丁', bloodType: '' }),
    ]
    expect(bloodTypeStats(list)).toEqual([
      { label: 'O', count: 2 },
      { label: 'AB', count: 1 },
    ])
  })
})

describe('birthMonthStats（生日月份）', () => {
  it('恒返回 1-12 月：日历读法要的正是「哪个月空着」', () => {
    const list = [
      makeMember({ realName: '甲', birthday: '1998-03-15' }),
      makeMember({ realName: '乙', birthday: '03-20' }),
      makeMember({ realName: '丙', birthday: '' }),
    ]
    const result = birthMonthStats(list)
    expect(result).toHaveLength(12)
    expect(result[0]).toEqual({ label: '1 月', count: 0 })
    expect(result[2]).toEqual({ label: '3 月', count: 2 })
    expect(result[11]).toEqual({ label: '12 月', count: 0 })
  })
})

describe('zodiacStats（生肖分布 —— 数据源给不出出生年份，看板已不挂这张图）', () => {
  it('按公历年份推算，1900 年为鼠年；没给年份的不计入', () => {
    const list = [
      makeMember({ realName: '甲', birthday: '2000-05-01' }), // 龙
      makeMember({ realName: '乙', birthday: '2012-05-01' }), // 龙
      makeMember({ realName: '丙', birthday: '2001-05-01' }), // 蛇
      makeMember({ realName: '丁', birthday: '03-15' }),
      makeMember({ realName: '戊', birthday: '' }),
    ]
    expect(zodiacStats(list)).toEqual([
      { label: '龙', count: 2 },
      { label: '蛇', count: 1 },
    ])
  })
})

describe('birthplaceRegion（出生地归一到省级）', () => {
  it('空格分隔、带省市后缀、自治区全称都能归到省级', () => {
    expect(birthplaceRegion('湖南 长沙')).toBe('湖南')
    expect(birthplaceRegion('湖南省长沙市')).toBe('湖南')
    expect(birthplaceRegion('内蒙古自治区呼和浩特市')).toBe('内蒙古')
    expect(birthplaceRegion('广西壮族自治区南宁市')).toBe('广西')
    expect(birthplaceRegion('北京市朝阳区')).toBe('北京')
  })

  it('剥掉开头的「中国」/「中华人民共和国」：上游大量使用「中国 四川」这种写法', () => {
    expect(birthplaceRegion('中国 四川')).toBe('四川')
    expect(birthplaceRegion('中国成都')).toBe('成都')
    expect(birthplaceRegion('中华人民共和国 湖南 长沙')).toBe('湖南')
  })

  it('空值返回空串', () => {
    expect(birthplaceRegion('')).toBe('')
    expect(birthplaceRegion(undefined)).toBe('')
  })

  it('认不出时只在它「像地名」时才保留原文（2-4 个纯汉字），否则判为无效', () => {
    expect(birthplaceRegion('成都')).toBe('成都')
    expect(birthplaceRegion('温州')).toBe('温州')
    // 上游用 `-` 当占位符（实测 37 人），放行它会在图里长出一根叫「-」的柱子
    expect(birthplaceRegion('-')).toBe('')
    expect(birthplaceRegion('--')).toBe('')
    expect(birthplaceRegion('滢112')).toBe('')
    expect(birthplaceRegion('火星殖民地基地')).toBe('')
  })
})

describe('birthplaceStats（出生地分布）', () => {
  it('按人数降序，传了 limit 才截断', () => {
    const list = [
      makeMember({ realName: '甲', birthplace: '湖南 长沙' }),
      makeMember({ realName: '乙', birthplace: '湖南 株洲' }),
      makeMember({ realName: '丙', birthplace: '广东 深圳' }),
      makeMember({ realName: '丁', birthplace: '四川 成都' }),
    ]
    expect(birthplaceStats(list, 2)).toEqual([
      { label: '湖南', count: 2 },
      { label: '广东', count: 1 },
    ])
  })

  it('不传 limit 时返回全部地区 —— 截断会让「合计」把真实覆盖人数显示小', () => {
    const list = [
      makeMember({ realName: '甲', birthplace: '湖南 长沙' }),
      makeMember({ realName: '乙', birthplace: '广东 深圳' }),
      makeMember({ realName: '丙', birthplace: '四川 成都' }),
      makeMember({ realName: '丁', birthplace: '' }),
    ]
    expect(birthplaceStats(list)).toHaveLength(3)
  })
})

describe('parseHeight（身高文本 → 厘米）', () => {
  it('认 2-3 位整数，带单位也认', () => {
    expect(parseHeight('168')).toBe(168)
    expect(parseHeight('168cm')).toBe(168)
    expect(parseHeight('175 CM')).toBe(175)
  })

  it('空值、超范围、小数写法一律判为无效', () => {
    expect(parseHeight('')).toBe(0)
    expect(parseHeight(undefined)).toBe(0)
    expect(parseHeight('1.68')).toBe(0)
    expect(parseHeight('999')).toBe(0)
  })
})

describe('heightRanking（身高之最）', () => {
  const list = [
    makeMember({ realName: '甲', height: '170' }),
    makeMember({ realName: '乙', height: '178' }),
    makeMember({ realName: '丙', height: '160' }),
    makeMember({ realName: '丁', height: '' }),
  ]

  it('最高 / 最矮各按序取前 N，平均只统计有效值', () => {
    const ranking = heightRanking(list, 2)
    expect(ranking.tallest.map(entry => entry.member.realName)).toEqual(['乙', '甲'])
    expect(ranking.shortest.map(entry => entry.member.realName)).toEqual(['丙', '甲'])
    expect(ranking.average).toBe(169)
    expect(ranking.counted).toBe(3)
  })

  it('无人有有效身高时平均为 0', () => {
    expect(heightRanking([makeMember({ realName: '甲', height: '' })]).average).toBe(0)
  })
})

describe('heightBucketStats（身高分档）', () => {
  const list = [
    makeMember({ realName: '甲', height: '152' }),
    makeMember({ realName: '乙', height: '158' }),
    makeMember({ realName: '丙', height: '160' }),
    makeMember({ realName: '丁', height: '164' }),
    makeMember({ realName: '戊', height: '164' }),
    makeMember({ realName: '己', height: '170' }),
    makeMember({ realName: '庚', height: '' }),
  ]

  it('按 5cm 分档、档位从矮到高 —— 身体数据读的是数轴，不按人数排', () => {
    expect(heightBucketStats(list)).toEqual([
      { label: '155 以下', count: 1 },
      { label: '155-159', count: 1 },
      { label: '160-164', count: 3 },
      { label: '170-174', count: 1 },
    ])
  })

  it('空档不渲染 —— 与生日月份刻意保留 0 人月份的策略相反（月份是固定日历，档位是任意切分）', () => {
    const result = heightBucketStats(list)
    expect(result.some(item => item.label === '165-169')).toBe(false)
    expect(result.some(item => item.count === 0)).toBe(false)
  })

  it('无人有有效身高时返回空数组，卡片走「暂无数据」分支', () => {
    expect(heightBucketStats([makeMember({ realName: '甲', height: '' })])).toEqual([])
  })
})

describe('statsOverview（概览数字）', () => {
  it('按三态计数，队伍数只数在团成员所在队伍，平均身高与 heightRanking 同口径', () => {
    const list = [
      makeMember({ realName: '甲', groupName: 'SNH48', teamName: 'TEAM SII', status: 1, height: '170' }),
      makeMember({ realName: '乙', groupName: 'SNH48', teamName: 'TEAM SII', status: 1, height: '180' }),
      makeMember({ realName: '丙', groupName: 'GNZ48', teamName: 'TEAM G', status: 1, height: '160' }),
      makeMember({ realName: '丁', groupName: 'GNZ48', teamName: 'TEAM G', status: 2, height: '' }),
      makeMember({ realName: '戊', groupName: 'BEJ48', teamName: 'TEAM B', status: 3, height: '' }),
    ]
    expect(statsOverview(list)).toEqual({
      total: 5,
      active: 3,
      hiatus: 1,
      left: 1,
      honorary: 0,
      teams: 2,
      averageHeight: 170,
      ranked: 0,
    })
  })

  it('荣誉毕业生 / 明星殿堂从「在团」移出并单列 honorary：四块相加仍等于总数', () => {
    const list = [
      makeMember({ realName: '甲', groupName: 'SNH48', teamName: 'TEAM SII', status: 1 }),
      makeMember({ realName: '乙', groupName: 'SNH48', teamName: '荣誉毕业生', status: 1 }),
      makeMember({ realName: '丙', groupName: 'SNH48', teamName: '明星殿堂', status: 1 }),
      makeMember({ realName: '丁', groupName: 'SNH48', teamName: 'TEAM SII', status: 2 }),
      makeMember({ realName: '戊', groupName: 'SNH48', teamName: 'TEAM SII', status: 3 }),
    ]
    const data = statsOverview(list)
    expect(data.active).toBe(1)
    expect(data.honorary).toBe(2)
    // 荣誉毕业生 / 明星殿堂 不算「在团队伍」
    expect(data.teams).toBe(1)
    // 恒等式：这是「单列 honorary」而不是「抹掉」的意义所在
    expect(data.total).toBe(data.active + data.hiatus + data.left + data.honorary)
  })

  it('ranked 只数有总选名次的（含已退团的历届上榜），名次为空或 0 都不算', () => {
    const list = [
      makeMember({ realName: '甲', status: 1, ranking: '3' }),
      makeMember({ realName: '乙', status: 3, ranking: '26' }),
      makeMember({ realName: '丙', status: 1, ranking: '0' }),
      makeMember({ realName: '丁', status: 1, ranking: '' }),
    ]
    expect(statsOverview(list).ranked).toBe(2)
  })
})
