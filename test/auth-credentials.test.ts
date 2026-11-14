import type { StoredAuth } from '../src/main/pocket48/auth-credentials'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AuthCredentialStore, TokenTemporarilyUnavailableError } from '../src/main/pocket48/auth-credentials'

function storedAuth(overrides: Partial<StoredAuth> = {}): StoredAuth {
  return {
    mobile: '13900000000',
    tokenEnc: '',
    tokenPlain: '',
    nickname: '测试成员',
    avatar: '',
    userId: '1',
    savedAt: 1,
    ...overrides,
  }
}

const profile = {
  mobile: '13900000000',
  nickname: '测试成员',
  avatar: '',
  userId: '1',
  savedAt: 2,
}

function fixture(initial: StoredAuth | null = null) {
  let disk = initial
  const cipher = {
    isEncryptionAvailable: vi.fn(async () => true),
    encrypt: vi.fn(async (token: string) => `enc:${token}`),
    decrypt: vi.fn(async (encoded: string) => ({ token: encoded.replace(/^enc:/, ''), shouldReEncrypt: false })),
  }
  const file = {
    read: vi.fn(() => disk),
    write: vi.fn((auth: StoredAuth) => { disk = auth }),
    remove: vi.fn(() => { disk = null }),
  }
  const report = vi.fn()
  const onToken = vi.fn()
  const wait = vi.fn(async () => {})
  const store = new AuthCredentialStore(cipher, file, report, onToken, wait)
  return { store, cipher, file, report, onToken, wait, disk: () => disk }
}

describe('authCredentialStore / 载入', () => {
  it('旧版同步密文由异步 API 解开；重新载入会重新同步磁盘', async () => {
    const { store, cipher, onToken, file } = fixture(storedAuth({ tokenEnc: 'enc:token-1' }))
    await store.load()
    expect(store.getToken()).toBe('token-1')
    expect(store.getStored()?.mobile).toBe('13900000000')
    expect(cipher.decrypt).toHaveBeenCalledTimes(1)
    expect(onToken).toHaveBeenCalledWith('token-1')

    file.write(storedAuth({ tokenEnc: 'enc:token-new' }))
    await store.load()
    expect(store.getToken()).toBe('token-new')
    expect(cipher.decrypt).toHaveBeenCalledTimes(2)
    expect(onToken).toHaveBeenCalledTimes(2)
  })

  it('明文降级凭证直接读 tokenPlain，不触发解密', async () => {
    const { store, cipher } = fixture(storedAuth({ tokenPlain: 'plain-token' }))
    await store.load()
    expect(store.getToken()).toBe('plain-token')
    expect(cipher.decrypt).not.toHaveBeenCalled()
  })

  it('无凭证文件时视为未登录', async () => {
    const { store } = fixture()
    await store.load()
    expect(store.getToken()).toBe('')
    expect(store.getStored()).toBeNull()
  })

  it('密文损坏：按未登录处理但保留磁盘快照（档位 / 手机号不丢），不删文件', async () => {
    const { store, cipher, file, report } = fixture(storedAuth({ tokenEnc: 'broken', mobile: '13800000000' }))
    cipher.decrypt.mockRejectedValueOnce(new Error('decrypt failed'))
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.getToken()).toBe('')
    expect(store.getStored()?.mobile).toBe('13800000000')
    expect(file.remove).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalled()
  })

  it('钥匙环临时不可用会重试，耗尽后仍不抛且不会误删凭证', async () => {
    const retrying = fixture(storedAuth({ tokenEnc: 'enc:token-2' }))
    retrying.cipher.decrypt
      .mockRejectedValueOnce(new TokenTemporarilyUnavailableError('try again'))
      .mockResolvedValueOnce({ token: 'token-2', shouldReEncrypt: false })
    await retrying.store.load()
    expect(retrying.store.getToken()).toBe('token-2')
    expect(retrying.wait).toHaveBeenCalledTimes(1)

    const exhausted = fixture(storedAuth({ tokenEnc: 'enc:token-3' }))
    exhausted.cipher.decrypt.mockRejectedValue(new TokenTemporarilyUnavailableError('try again'))
    await expect(exhausted.store.load()).resolves.toBeUndefined()
    expect(exhausted.cipher.decrypt).toHaveBeenCalledTimes(3)
    expect(exhausted.store.getToken()).toBe('')
    expect(exhausted.file.remove).not.toHaveBeenCalled()
  })

  it('shouldReEncrypt=true 时换新密文写回；false 时不动磁盘', async () => {
    const rotated = fixture(storedAuth({ tokenEnc: 'enc:token-4' }))
    rotated.cipher.decrypt.mockResolvedValueOnce({ token: 'token-4', shouldReEncrypt: true })
    await rotated.store.load()
    expect(rotated.disk()?.tokenEnc).toBe('enc:token-4')
    expect(rotated.store.getToken()).toBe('token-4')

    const plain = fixture(storedAuth({ tokenEnc: 'enc:token-5' }))
    await plain.store.load()
    expect(plain.file.write).not.toHaveBeenCalled()
  })

  it('轮换重加密失败时保留原密文，本次会话的 token 仍可用', async () => {
    const { store, cipher, file, report } = fixture(storedAuth({ tokenEnc: 'old-enc' }))
    cipher.decrypt.mockResolvedValueOnce({ token: 'token-6', shouldReEncrypt: true })
    cipher.encrypt.mockRejectedValueOnce(new Error('encrypt failed'))
    await store.load()
    expect(store.getToken()).toBe('token-6')
    expect(file.write).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalled()
  })
})

describe('authCredentialStore / 保存与状态', () => {
  it('加密可用时只落密文，明文 token 立即同步可读', async () => {
    const { store, disk } = fixture()
    await expect(store.save(profile, 'token-7')).resolves.toBe(true)
    expect(disk()?.tokenEnc).toBe('enc:token-7')
    expect(disk()?.tokenPlain).toBe('')
    expect(store.getToken()).toBe('token-7')
    expect(store.getStored()?.savedAt).toBe(2)
  })

  it('加密不可用时降级明文，且不留空密文', async () => {
    const { store, cipher, disk } = fixture()
    cipher.isEncryptionAvailable.mockResolvedValueOnce(false)
    await expect(store.save(profile, 'token-8')).resolves.toBe(false)
    expect(cipher.encrypt).not.toHaveBeenCalled()
    expect(disk()?.tokenPlain).toBe('token-8')
    expect(disk()?.tokenEnc).toBe('')
  })

  it('探测加密能力失败按明文降级，但加密本身失败不静默降级', async () => {
    const unavailable = fixture()
    unavailable.cipher.isEncryptionAvailable.mockRejectedValueOnce(new Error('keyring down'))
    await expect(unavailable.store.save(profile, 'token-9')).resolves.toBe(false)
    expect(unavailable.report).toHaveBeenCalled()

    const failed = fixture()
    failed.cipher.encrypt.mockRejectedValueOnce(new Error('encrypt failed'))
    await expect(failed.store.save(profile, 'token-10')).rejects.toThrow('encrypt failed')
    expect(failed.disk()).toBeNull()
    expect(failed.store.getToken()).toBe('')
  })

  it('资料回写不动 token 字段，无变化不写盘', async () => {
    const { store, file, disk } = fixture()
    await store.save(profile, 'token-11')
    const before = disk()
    store.update({ nickname: '测试成员' })
    expect(file.write).toHaveBeenCalledTimes(1)
    store.update({ nickname: '新昵称' })
    expect(file.write).toHaveBeenCalledTimes(2)
    expect(store.getStored()?.nickname).toBe('新昵称')
    expect(store.getStored()?.tokenEnc).toBe(before?.tokenEnc)
    expect(store.getToken()).toBe('token-11')
  })

  it('退出后清空内存与文件，重新 load 也不会把旧凭证读回来', async () => {
    const { store, file, disk } = fixture(storedAuth({ tokenEnc: 'enc:token-12' }))
    await store.load()
    store.clear()
    await store.load()
    expect(store.getToken()).toBe('')
    expect(store.getStored()).toBeNull()
    expect(disk()).toBeNull()
    expect(file.remove).toHaveBeenCalledTimes(1)
  })
})

describe('safeStorage 弃用迁移', () => {
  it('主进程不再调用同步 API，且异步 API 三个入口都在', () => {
    const source = readFileSync(new URL('../src/main/pocket48/pocket-auth.ts', import.meta.url), 'utf8')
    expect(/\bsafeStorage\.(?:isEncryptionAvailable|encryptString|decryptString)\s*\(/.test(source)).toBe(false)
    for (const name of ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync'])
      expect(source).toContain(`safeStorage.${name}`)
  })
})
