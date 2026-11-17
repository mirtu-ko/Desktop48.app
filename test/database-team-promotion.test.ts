import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Database } from '../src/main/database'

/**
 * 预备生的本地升格：归属由主进程给出，数据库只回该账号的升格内容；
 * 写入按 ownerId + userId 覆盖，取消只删当前账号的记录。
 */
function tempDatabaseFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'desktop48-db-promotion-')), 'database.json')
}

const owner = '20001'
const promotion = { userId: 10001, teamName: 'TEAM SII', teamColor: '90CCEA' }
const stored = { ...promotion, ownerId: owner }

describe('database 预备生本地升格', () => {
  it('全新库返回空数组', () => {
    const instance = new Database(tempDatabaseFile())
    instance.init()
    expect(instance.getMemberTeamPromotions(owner)).toEqual([])
  })

  it('写入后可从新实例读回（落盘生效，读取不带 ownerId）', () => {
    const dbPath = tempDatabaseFile()
    const instance = new Database(dbPath)
    instance.init()
    instance.setMemberTeamPromotion(promotion, owner)

    const restarted = new Database(dbPath)
    restarted.init()
    expect(restarted.getMemberTeamPromotions(owner)).toEqual([promotion])
  })

  it('读取只回当前账号，其他账号的升格不外泄', () => {
    const instance = new Database(tempDatabaseFile())
    instance.init()
    instance.setMemberTeamPromotion(promotion, owner)
    instance.setMemberTeamPromotion({ ...promotion, teamName: 'TEAM NII' }, '20002')

    expect(instance.getMemberTeamPromotions(owner)).toEqual([promotion])
    expect(instance.getMemberTeamPromotions('20002')).toEqual([{ ...promotion, teamName: 'TEAM NII' }])
    expect(instance.getMemberTeamPromotions('nobody')).toEqual([])
  })

  it('同一账号的同一成员重复设置只保留最后一条', () => {
    const instance = new Database(tempDatabaseFile())
    instance.init()
    instance.setMemberTeamPromotion(promotion, owner)
    instance.setMemberTeamPromotion({ ...promotion, teamName: 'TEAM NII', teamColor: 'AD85BA' }, owner)

    expect(instance.getMemberTeamPromotions(owner)).toEqual([
      { ...promotion, teamName: 'TEAM NII', teamColor: 'AD85BA' },
    ])
  })

  it('渲染层伪造的 ownerId / 冗余字段不会落盘', () => {
    const dbPath = tempDatabaseFile()
    const instance = new Database(dbPath)
    instance.init()
    const forged = { ...promotion, ownerId: 'hacked', groupId: 10, groupName: 'SNH48' }
    instance.setMemberTeamPromotion(forged, owner)

    expect(JSON.parse(readFileSync(dbPath, 'utf8')).memberTeamPromotions).toEqual([stored])
  })

  it('取消升格只删当前账号的记录；不存在的记录不写盘', () => {
    const instance = new Database(tempDatabaseFile())
    instance.init()
    instance.setMemberTeamPromotion(promotion, owner)
    instance.setMemberTeamPromotion(promotion, '20002')
    instance.removeMemberTeamPromotion(owner, 10001)
    instance.removeMemberTeamPromotion(owner, 99999)

    expect(instance.getMemberTeamPromotions(owner)).toEqual([])
    expect(instance.getMemberTeamPromotions('20002')).toEqual([promotion])
  })

  it('init 归一旧库脏记录（去重 + 丢弃无效项 + 剥掉旧字段）并写回', () => {
    const dbPath = tempDatabaseFile()
    writeFileSync(dbPath, JSON.stringify({
      memberTeamPromotions: [
        { ownerId: owner, userId: '10001', groupName: 'SNH48', teamName: '预备生', teamColor: '' },
        { ownerId: owner, userId: 10001, groupId: 10, groupName: 'SNH48', teamName: 'TEAM SII', teamColor: '90CCEA' },
        { ownerId: 'bad', userId: 'bad', groupName: 'SNH48', teamName: 'TEAM NII', teamColor: '' },
        { userId: 10003, groupName: 'SNH48', teamName: 'TEAM HII', teamColor: '' },
      ],
    }))

    const instance = new Database(dbPath)
    instance.init()

    expect(instance.getMemberTeamPromotions(owner)).toEqual([promotion])
    expect(JSON.parse(readFileSync(dbPath, 'utf8')).memberTeamPromotions).toEqual([stored])
  })
})
