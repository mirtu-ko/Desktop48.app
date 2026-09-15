import type { AllMemberItem } from '../src/preload/ipc-contract'
import type { MemberTreeLike } from '../src/renderer/src/utils/member-merge'
import { describe, expect, it } from 'vitest'
import { mergeMembers } from '../src/renderer/src/utils/member-merge'

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
