import type { MemberTreeGroupPayload } from '../src/preload/ipc-contract'
import { describe, expect, it } from 'vitest'
import {
  assertMemberTeamPromotion,
  isTraineeTeam,
  normalizeMemberTeamPromotionItem,
  normalizeMemberTeamPromotions,
  promotionOwnerId,
} from '../src/common/member-team-promotion'
import { resolveMemberTeam, teamOptionsOfMember } from '../src/renderer/src/utils/member-team-promotion'

describe('isTraineeTeam（升格资格判据）', () => {
  it('只认服务端的「预备生」队伍名，忽略首尾空白', () => {
    expect(isTraineeTeam('预备生')).toBe(true)
    expect(isTraineeTeam(' 预备生 ')).toBe(true)
  })

  it('正式队伍、荣誉队伍与脏值都不算预备生', () => {
    expect(isTraineeTeam('TEAM SII')).toBe(false)
    expect(isTraineeTeam('荣誉毕业生')).toBe(false)
    expect(isTraineeTeam('')).toBe(false)
    expect(isTraineeTeam(undefined)).toBe(false)
  })
})

describe('promotionOwnerId（账号身份）', () => {
  it('未登录返回空串', () => {
    expect(promotionOwnerId({ loggedIn: false, userId: '20001', mobileMasked: '139****1234' })).toBe('')
  })

  it('优先 userId；缺失时退脱敏手机号，明文手机号不落库', () => {
    expect(promotionOwnerId({ loggedIn: true, userId: '20001', mobileMasked: '139****1234' })).toBe('20001')
    expect(promotionOwnerId({ loggedIn: true, userId: '', mobileMasked: '139****1234' })).toBe('139****1234')
  })

  it('身份字段全空时返回空串，写入会被主进程拒绝', () => {
    expect(promotionOwnerId({ loggedIn: true })).toBe('')
  })
})

describe('assertMemberTeamPromotion / normalizeMemberTeamPromotionItem（IPC 校验与白名单）', () => {
  it('接受合法升格，归一时剥掉伪造的 ownerId 与旧库冗余字段', () => {
    const forged = { userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA', ownerId: 'hacked', groupId: 10, groupName: 'SNH48' }
    expect(() => assertMemberTeamPromotion(forged)).not.toThrow()
    expect(normalizeMemberTeamPromotionItem(forged)).toEqual({ userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' })
  })

  it('拒绝空队名 / 脏 userId / 非对象', () => {
    expect(() => assertMemberTeamPromotion({ userId: 1, teamName: '  ', teamColor: '' })).toThrow(TypeError)
    expect(() => assertMemberTeamPromotion({ userId: 'bad', teamName: 'TEAM SII', teamColor: '' })).toThrow(TypeError)
    expect(() => assertMemberTeamPromotion(null)).toThrow(TypeError)
    expect(normalizeMemberTeamPromotionItem({ userId: 1, teamName: '', teamColor: '' })).toBeNull()
  })
})

describe('normalizeMemberTeamPromotions（旧库归一）', () => {
  it('丢弃脏记录、同一账号同一成员保留最后一条，并剥掉旧字段', () => {
    const normalized = normalizeMemberTeamPromotions([
      { ownerId: '20001', userId: '10001', groupName: 'SNH48', teamName: '预备生', teamColor: '' },
      { ownerId: '20001', userId: 10001, groupId: 10, groupName: 'SNH48', teamName: 'TEAM SII', teamColor: '90CCEA' },
      { ownerId: 'bad', userId: 'bad', groupName: 'SNH48', teamName: 'TEAM NII', teamColor: '' },
      { ownerId: '20001', userId: 10002, groupName: 'SNH48', teamName: '   ', teamColor: '' },
      { userId: 10003, groupName: 'SNH48', teamName: 'TEAM HII', teamColor: '' },
    ])

    expect(normalized).toEqual([
      { ownerId: '20001', userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' },
    ])
  })

  it('不同账号对同一成员的记录互不覆盖', () => {
    const normalized = normalizeMemberTeamPromotions([
      { ownerId: '20001', userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' },
      { ownerId: '20002', userId: 10001, teamName: 'TEAM NII', teamColor: 'AD85BA' },
    ])

    expect(normalized.map(item => item.ownerId)).toEqual(['20001', '20002'])
  })

  it('非数组按空名单处理', () => {
    expect(normalizeMemberTeamPromotions(undefined)).toEqual([])
    expect(normalizeMemberTeamPromotions({})).toEqual([])
  })
})

describe('teamOptionsOfMember（只认有队徽的队伍）', () => {
  const tree: MemberTreeGroupPayload[] = [
    {
      groupId: 10,
      groupName: 'SNH48',
      label: 'SNH48',
      value: '10',
      children: [
        {
          teamName: 'TEAM SII',
          label: 'TEAM SII',
          value: '100',
          teamBadge: '/backstage/sii.png',
          teamColor: '90CCEA',
          children: [{ label: '甲', value: '10001', userId: 10001 }],
        },
        { teamName: 'TEAM NII', label: 'TEAM NII', value: '101', teamBadge: '/backstage/nii.png', teamColor: 'AD85BA', children: [] },
        { teamName: '预备生', label: '预备生', value: '102', teamBadge: '/backstage/trainee.png', teamColor: '', children: [{ label: '乙', value: '10002', userId: 10002 }] },
        { teamName: 'TEAM XII', label: 'TEAM XII', value: '103', teamBadge: '', teamColor: 'CCCCCC', children: [] },
      ],
    },
  ]

  it('按成员所在团体取队伍：无队徽的已解散队伍与预备生本人都不出现', () => {
    expect(teamOptionsOfMember(tree, 10001).map(team => team.teamName)).toEqual(['TEAM SII', 'TEAM NII'])
    expect(teamOptionsOfMember(tree, 10002).map(team => team.teamName)).toEqual(['TEAM SII', 'TEAM NII'])
  })

  it('队名 / 队色 / 队徽来自同一份队伍记录，队徽已归一化', () => {
    const [sii] = teamOptionsOfMember(tree, 10001)
    expect(sii.teamColor).toBe('90CCEA')
    expect(sii.groupName).toBe('SNH48')
    expect(sii.teamBadge).toContain('sii.png')
    expect(sii.teamBadge.startsWith('http')).toBe(true)
  })

  it('查不到成员 / userId 脏值 / 空树都返回空数组', () => {
    expect(teamOptionsOfMember(tree, 99999)).toEqual([])
    expect(teamOptionsOfMember(tree, 'bad')).toEqual([])
    expect(teamOptionsOfMember([], 10001)).toEqual([])
  })
})

describe('resolveMemberTeam（展示层覆盖）', () => {
  const promotion = { userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' }

  it('仍是预备生时用本地升格队伍', () => {
    expect(resolveMemberTeam({ teamName: '预备生', teamColor: 'a7b0ba' }, promotion))
      .toEqual({ teamName: 'TEAM SII', teamColor: '90CCEA' })
  })

  it('没有本地记录时原样返回', () => {
    expect(resolveMemberTeam({ teamName: '预备生', teamColor: 'a7b0ba' }, null))
      .toEqual({ teamName: '预备生', teamColor: 'a7b0ba' })
  })

  it('她已正式升格，本地升格不再生效', () => {
    expect(resolveMemberTeam({ teamName: 'TEAM NII', teamColor: 'AD85BA' }, promotion))
      .toEqual({ teamName: 'TEAM NII', teamColor: 'AD85BA' })
  })

  it('缺字段时归一为空串，不把 undefined 漏进模板', () => {
    expect(resolveMemberTeam({}, null)).toEqual({ teamName: '', teamColor: '' })
  })
})
