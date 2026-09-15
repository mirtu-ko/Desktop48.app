import type { AllMemberItem } from '../src/preload/ipc-contract'
import type { MemberTreeLike } from '../src/renderer/src/utils/member-merge'
import { describe, expect, it } from 'vitest'
import { buildAdjuncts, mergeMembers } from '../src/renderer/src/utils/member-merge'

/**
 * 用例按真实数据的三种形态构造：
 * - 常规成员：starInfo 有 userId / 头像，allmembers 用 pocket_id 或头像 sid 对应
 * - 同名成员：两个分团各一条（真实数据里的「李想」「陈佳莹」），需要按头像 sid / 分团消歧
 * - 镜像重复：官网对同一人留两条（首次登记的 SNH 体系 + 现属分团，同名同期数）
 */
describe('mergeMembers（两数据源合并的纯函数）', () => {
  const tree: MemberTreeLike[] = [
    {
      groupName: 'SNH48',
      groupId: 10,
      children: [
        {
          teamName: 'TEAM SII',
          teamBadge: '/backstage/sii.png',
          children: [
            {
              userId: 1,
              realName: '甲',
              nickname: '甲甲',
              avatar: 'https://www.snh48.com/images/member/zp_10001.jpg',
              teamColor: '90CCEA',
              status: 1,
              birthday: '',
              specialty: '唱歌',
              hobbies: '',
              wbName: 'SNH48-甲',
              wbUid: '123',
              fullPhoto1: '/photo/1.jpg',
              fullPhoto2: '',
            },
            { userId: 2, realName: '乙', avatar: 'https://www.snh48.com/images/member/zp_20030.jpg', status: 1 },
            // 同名成员的另一条：官网那条记录的分团映射不出两侧任一分团，只有头像 sid 能判对
            { userId: 7, realName: '己', avatar: '', status: 1 },
          ],
        },
      ],
    },
    {
      groupName: 'GNZ48',
      groupId: 12,
      children: [
        {
          teamName: 'TEAM G',
          teamBadge: '',
          children: [{ userId: 4, realName: '丙', avatar: '', status: 2, teamColor: '' }],
        },
      ],
    },
    {
      groupName: 'SHY48',
      groupId: 13,
      children: [
        {
          teamName: 'TEAM HIII',
          teamBadge: '',
          // 同名成员的另一条：官网那条的 gid 映射不出这个分团，只有头像里的 sid 是线索
          children: [
            { userId: 5, realName: '丙', avatar: 'https://www.snh48.com/images/member/zp_40018.jpg', status: 1 },
            { userId: 8, realName: '己', avatar: 'https://www.snh48.com/images/member/zp_20181.jpg', status: 1 },
          ],
        },
      ],
    },
    {
      groupName: 'CKG48',
      groupId: 14,
      children: [
        {
          teamName: 'TEAM K',
          teamBadge: '',
          children: [{ userId: 6, realName: '戊', avatar: 'https://source.48.cn/avatar/6.jpg', status: 1 }],
        },
      ],
    },
  ]

  const allmembers: AllMemberItem[] = [
    // pocket_id 精确命中 userId 1；starInfo 已有值优先，缺的用官网补
    {
      sid: '10001',
      sname: '甲',
      pocket_id: '1',
      gid: '10',
      tname: 'SII',
      status: '99',
      ranking: '12',
      experience: '2012.10.14 加入<br>2013.05.01 升格',
      company: '上海丝芭文化传媒集团有限公司',
      star_sign_12: '金牛座',
      birth_day: '05.11',
      height: '170',
      hobby: '看书',
      pname: 'SNH48 一期生',
    },
    // 头像 sid 才配得上（pocket_id 为 0）
    { sid: '20030', sname: '乙', pocket_id: '0', gid: '20', status: '99', ranking: '0' },
    // 同名成员之一：分团就能对上（gid 30 → groupId 12）
    { sid: '30018', sname: '丙', pocket_id: '0', gid: '30', status: '99', ranking: '3', pname: 'GNZ48 五期生' },
    // 同名成员之二：gid 映射不出分团，只能靠头像 sid 40018 认领
    { sid: '40018', sname: '丙', pocket_id: '0', gid: '10', status: '99', ranking: '7', pname: 'SNH48 五期生' },
    // 同名成员「己」：gid 70 → IDFT，与两侧分团都不一致，唯一线索是头像里的 sid 20181
    { sid: '20181', sname: '己', pocket_id: '0', gid: '70', status: '99', ranking: '9', pname: 'SHY48 三期生' },
    // 现属分团那条（gid 50 → groupId 14 对得上）= 应当被认领的那条
    { sid: '50085', sname: '戊', pocket_id: '0', gid: '50', status: '99', ranking: '5', pname: 'CKG48 六期生' },
    // 官网同一人的 SNH 体系镜像记录：同名同期数 → 丢弃，不产生重复卡片
    { sid: '10385', sname: '戊', pocket_id: '0', gid: '10', status: '99', pname: 'CKG48 六期生' },
    // 官网独有（库里没有这个人）：作为补充记录追加
    { sid: '40034', sname: '丁', pocket_id: '0', gid: '40', tname: 'HIII', status: '44', pname: 'SHY48 一期生' },
  ]

  const merged = mergeMembers(tree, allmembers)
  const byName = (realName: string) => merged.filter(member => member.realName === realName)

  it('树干骨架在前、官网独有记录追加在末尾，成员一条不多一条不少', () => {
    expect(merged.map(member => member.realName)).toEqual(['甲', '乙', '己', '丙', '丙', '己', '戊', '丁'])
    expect(merged.filter(member => member.userId !== undefined)).toHaveLength(7)
  })

  it('starInfo 字段优先，空值才回退 allmembers；队伍上下文来自成员树', () => {
    const [first] = byName('甲')
    expect(first.userId).toBe(1)
    expect(first.sid).toBe('10001')
    expect(first.nickname).toBe('甲甲')
    expect(first.teamName).toBe('TEAM SII')
    expect(first.teamBadge).toBe('https://source.48.cn/backstage/sii.png')
    expect(first.teamColor).toBe('90CCEA')
    expect(first.photos).toEqual(['https://source.48.cn/photo/1.jpg'])
    // 排名 / 经历 / 公司 / 星座 / 身高 / 爱好 只有官网有
    expect(first.ranking).toBe('12')
    expect(first.experience).toContain('加入')
    expect(first.company).toBe('上海丝芭文化传媒集团有限公司')
    expect(first.constellation).toBe('金牛座')
    expect(first.height).toBe('170')
    // starInfo 里生日为空 → 回退官网 birth_day
    expect(first.birthday).toBe('05.11')
  })

  it('接口用 \'0\' 表示「无」时归一化为空串（卡片不画皇冠）', () => {
    expect(byName('乙')[0].ranking).toBe('')
    expect(byName('甲')[0].ranking).not.toBe('')
  })

  it('同名成员按分团 / 头像 sid 各认领自己的那条，不会张冠李戴', () => {
    expect(byName('丙').map(member => member.userId)).toEqual([4, 5])
    expect(byName('丙').find(member => member.userId === 4)!.ranking).toBe('3')
    expect(byName('丙').find(member => member.userId === 5)!.ranking).toBe('7')
    // 「己」两侧分团都不是 gid 70 映射出的 IDFT，只有头像 sid 能挑对
    expect(byName('己').find(member => member.userId === 8)!.ranking).toBe('9')
    expect(byName('己').find(member => member.userId === 7)!.ranking).toBe('')
  })

  it('官网同一人的镜像记录（同名同期数）被丢弃，保留现属分团那条', () => {
    expect(merged.filter(member => member.sid === '10385')).toHaveLength(0)
    expect(byName('戊')).toHaveLength(1)
    expect(byName('戊')[0].ranking).toBe('5')
  })

  it('官网独有的成员作为无 userId 的补充记录：状态按 99/44 映射，头像按 sid 拼', () => {
    const [only] = byName('丁')
    expect(only.userId).toBeUndefined()
    // 44 = 离团；starInfo 只有「在团 / 暂休 / 退团」三态，映射到 退团(3)
    expect(only.status).toBe(3)
    expect(only.avatar).toBe('https://www.snh48.com/images/member/zp_40034.jpg')
    // gid 40 → groupId 13，团体名沿用树里的写法
    expect(only.groupId).toBe(13)
    expect(only.groupName).toBe('SHY48')
    expect(only.teamName).toBe('HIII')
  })

  it('空输入不抛错：没有官网数据时成员仍在，缺省字段为空串', () => {
    expect(mergeMembers(undefined, undefined)).toEqual([])
    const [onlyTree] = mergeMembers(tree, undefined).filter(member => member.realName === '乙')
    expect(onlyTree.avatar).toBe('https://www.snh48.com/images/member/zp_20030.jpg')
    expect(onlyTree.ranking).toBe('')
    expect(onlyTree.company).toBe('')
    expect(onlyTree.status).toBe(1)
  })
})

/**
 * 兼任成员（starAdjunctInfo）的展示记录：详情一律取本人档案，档案只负责队伍定位。
 * 用例覆盖数据里真实存在的四种形态：正常兼任 / 本人档案暂休 / 无效档案 / 队伍查不到。
 */
describe('buildAdjuncts（兼任记录 = 本人档案 + 兼任队伍定位）', () => {
  // 主队：SNH48 TEAM SII（队色 90CCEA）；兼任队伍：GNZ48 TEAM G（队色 AAC913）
  const tree: MemberTreeLike[] = [
    {
      groupName: 'SNH48',
      groupId: 10,
      children: [
        {
          teamName: 'TEAM SII',
          value: '101',
          teamBadge: '/backstage/sii.png',
          children: [
            {
              userId: 1,
              realName: '甲',
              nickname: '甲甲',
              avatar: 'https://www.snh48.com/images/member/zp_10001.jpg',
              teamColor: '90CCEA',
              status: 1,
              wbUid: '123',
              fullPhoto1: '/photo/1.jpg',
              fullPhoto2: '',
            },
            { userId: 2, realName: '乙', avatar: '', teamColor: '90CCEA', status: 1 },
          ],
        },
      ],
    },
    {
      groupName: 'GNZ48',
      groupId: 12,
      children: [
        {
          teamName: 'TEAM G',
          value: '402',
          teamBadge: '/backstage/gnz-g.png',
          // 本人档案是暂休态：兼任有效时仍要出现在在团分区
          children: [{ userId: 4, realName: '丙', avatar: '', teamColor: 'AAC913', status: 2 }],
        },
      ],
    },
  ]

  const allmembers: AllMemberItem[] = [
    {
      sid: '10001',
      sname: '甲',
      pocket_id: '1',
      gid: '10',
      tname: 'SII',
      status: '99',
      ranking: '12',
      experience: '2012.10.14 加入',
      company: '上海丝芭文化传媒集团有限公司',
      birth_day: '05.11',
    },
  ]

  const merged = mergeMembers(tree, allmembers)

  const adjuncts = [
    // 甲：主队 SNH48 TEAM SII → 兼任 GNZ48 TEAM G
    { adjunctId: 11, userId: 1, starName: '甲', headImg: 'https://source.48.cn/adj/1.jpg', groupId: 12, teamId: 402, status: 1 },
    // 丙：主队 GNZ48 TEAM G（本人档案暂休）→ 兼任 SNH48 TEAM SII
    { adjunctId: 12, userId: 4, starName: '丙', headImg: '', groupId: 10, teamId: 101, status: 1 },
    // 无效档案（status !== 1）不展示
    { adjunctId: 13, userId: 2, starName: '乙', headImg: '', groupId: 10, teamId: 101, status: 0 },
    // 队伍 id 在树里查不到 → 定位不到队伍，丢弃
    { adjunctId: 14, userId: 2, starName: '乙', headImg: '', groupId: 10, teamId: 999, status: 1 },
    // 本人档案缺失（库里没有这个 userId）→ 姓名 / 头像 / userId 退回归档本身
    { adjunctId: 15, userId: 999, starName: '戊', headImg: 'https://source.48.cn/adj/5.jpg', groupId: 12, teamId: 402, status: 1 },
    // 兼任队伍就是本人主队（甲的主队是 SNH48 TEAM SII）→ 不产生新信息，跳过
    { adjunctId: 16, userId: 1, starName: '甲', headImg: '', groupId: 10, teamId: 101, status: 1 },
  ]

  const list = buildAdjuncts(merged, tree, adjuncts)

  it('只保留有效且能定位队伍的档案，按档案归入兼任队伍', () => {
    expect(list.map(member => member.realName)).toEqual(['甲', '丙', '戊'])
    expect(list.map(member => member.teamName)).toEqual(['TEAM G', 'TEAM SII', 'TEAM G'])
    expect(list.map(member => member.groupName)).toEqual(['GNZ48', 'SNH48', 'GNZ48'])
    expect(list.map(member => member.adjunctId)).toEqual([11, 12, 15])
  })

  it('兼任队伍与本人主队相同时跳过该档案（否则同一分区会出现同一人两张卡）', () => {
    expect(list.some(member => member.adjunctId === 16)).toBe(false)
  })

  it('详情字段取自本人档案（抽屉里不再缺资料）', () => {
    const [jia] = list
    expect(jia.userId).toBe(1)
    expect(jia.nickname).toBe('甲甲')
    expect(jia.wbUid).toBe('123')
    expect(jia.birthday).toBe('05.11')
    expect(jia.ranking).toBe('12')
    expect(jia.experience).toBe('2012.10.14 加入')
    expect(jia.company).toBe('上海丝芭文化传媒集团有限公司')
    expect(jia.photos).toEqual(['https://source.48.cn/photo/1.jpg'])
    // 头像也跟随本人档案，与普通卡片是同一张
    expect(jia.avatar).toBe('https://www.snh48.com/images/member/zp_10001.jpg')
  })

  it('队伍名 / 队色 / 徽章换成兼任队伍的，头像圆环仍取主队色', () => {
    const [jia] = list
    expect(jia.teamColor).toBe('AAC913')
    expect(jia.teamBadge).toBe('https://source.48.cn/backstage/gnz-g.png')
    expect(jia.ringColor).toBe('90CCEA')
    expect(jia.adjunctId).toBe(11)
  })

  it('有效兼任按在团展示（本人档案是暂休态也进在团分区）', () => {
    const bing = list.find(member => member.userId === 4)!
    expect(bing.status).toBe(1)
    expect(bing.teamName).toBe('TEAM SII')
    // 圆环仍是他自己的队伍（GNZ48 TEAM G）色
    expect(bing.ringColor).toBe('AAC913')
  })

  it('本人档案缺失时退回归档内容，不整条丢展示', () => {
    const fallback = list.find(member => member.userId === 999)!
    expect(fallback.realName).toBe('戊')
    expect(fallback.avatar).toBe('https://source.48.cn/adj/5.jpg')
    expect(fallback.teamName).toBe('TEAM G')
    expect(fallback.ranking).toBe('')
    expect(fallback.ringColor).toBe('')
  })

  it('空输入不抛错：没有档案 / 没有成员数据都返回空数组', () => {
    expect(buildAdjuncts(merged, tree, undefined)).toEqual([])
    expect(buildAdjuncts(merged, tree, [])).toEqual([])
    expect(buildAdjuncts([], tree, adjuncts).map(member => member.realName)).toEqual(['甲', '丙', '戊'])
  })
})
