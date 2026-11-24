import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDatabaseIPC } from '../src/main/ipc/register-database-ipc'
import { handleTraced } from '../src/main/ipc/trace'

vi.mock('../src/main/ipc/trace', () => ({
  handleTraced: vi.fn(),
}))

vi.mock('../src/main/database', () => ({
  Database: {
    instance: vi.fn(),
  },
}))

vi.mock('../src/main/pocket48/pocket-auth', () => ({
  getAuthState: vi.fn(() => ({ loggedIn: false, userId: '', mobileMasked: '' })),
}))

describe('registerDatabaseIPC 通道注册', () => {
  beforeEach(() => {
    vi.mocked(handleTraced).mockClear()
  })

  it('注册 preload 数据库 API 所需的全部 invoke 通道', () => {
    registerDatabaseIPC()

    const channels = vi.mocked(handleTraced).mock.calls.map(([channel]) => channel)
    expect(channels.sort()).toEqual([
      'addMemberFlag',
      'addMemberFlags',
      'getAllMembers',
      'getMemberFlags',
      'getMemberInfo',
      'getMemberTeamPromotions',
      'getMemberTree',
      'hasMembers',
      'removeMemberFlag',
      'removeMemberTeamPromotion',
      'saveMemberData',
      'setMemberFlags',
      'setMemberTeamPromotion',
    ])
  })
})
