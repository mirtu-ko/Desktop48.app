import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Database } from '../src/main/database'

/**
 * Database.getMemberFlagIds：名单 id 的轻量读法。
 *
 * 主进程未读检测每轮都要读屏蔽名单把成员从检测范围里剔除（见 pocket-unread 的 tick），
 * 这条路径只要 id、不解析成员详情，因此单独一个方法而不是复用 getMemberFlags。
 * 旧库存过字符串形式的 id（见 DatabaseShape 的字段注释），这里要归一回数字。
 */
function tempDatabaseFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'desktop48-db-flags-')), 'database.json')
}

describe('database 名单 id 读取', () => {
  it('旧库里的字符串 id 归一成数字，两类名单互不串', () => {
    const dbPath = tempDatabaseFile()
    writeFileSync(dbPath, JSON.stringify({
      blockedMemberIds: ['10001', 10002],
      followedMemberIds: [10003],
    }))

    const instance = new Database(dbPath)
    instance.init()

    expect(instance.getMemberFlagIds('blocked')).toEqual([10001, 10002])
    expect(instance.getMemberFlagIds('followed')).toEqual([10003])
  })

  it('全新库返回空数组（不是 undefined）', () => {
    const dbPath = tempDatabaseFile()
    const instance = new Database(dbPath)
    instance.init()

    expect(instance.getMemberFlagIds('blocked')).toEqual([])
  })
})
