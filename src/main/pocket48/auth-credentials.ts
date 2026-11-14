/**
 * 口袋48 凭证的读写入口：磁盘是凭证真相，只有解密后的明文 token 因异步 API 无法同步取得而留在内存。
 * safeStorage 的加解密只在载入 / 保存时各做一次，业务侧仍按原口径读盘取快照、读内存取 token。
 * 加解密与文件读写由调用方注入，本模块不依赖 Electron，可在 node 环境单测。
 */
import type { PocketClientProfileId } from '@common/pocket-client-profile'

/** 落盘形态：token 以系统密文或明文降级二选一保存，二者不同时有值 */
export interface StoredAuth {
  /** 记住手机号（下次打开弹窗预填；明文，手机号本身不算机密） */
  mobile: string
  /** 登录时使用的区号（如 '852'）；旧版本无此字段，读取时按 86 处理 */
  area?: string
  /** 登录时选定的客户端档位；旧版本无此字段，读取时按口袋48 处理 */
  clientProfile?: PocketClientProfileId
  tokenEnc: string
  tokenPlain: string
  nickname: string
  avatar: string
  userId: string
  savedAt: number
}

export interface DecryptedToken {
  token: string
  /** 密钥已轮换或出现更高安全级别的密钥，应把明文重新加密后写回 */
  shouldReEncrypt: boolean
}

export interface TokenCipher {
  isEncryptionAvailable: () => Promise<boolean>
  encrypt: (token: string) => Promise<string>
  decrypt: (encoded: string) => Promise<DecryptedToken>
}

export interface AuthFile {
  read: () => StoredAuth | null
  write: (auth: StoredAuth) => void
  remove: () => void
}

/** 系统密钥环短暂不可用（如 Linux 钥匙环未解锁）：与密文损坏区分，前者重试，后者按未登录处理 */
export class TokenTemporarilyUnavailableError extends Error {}

type Reporter = (message: string, error?: unknown) => void
type Profile = Omit<StoredAuth, 'tokenEnc' | 'tokenPlain'>
type ProfilePatch = Partial<Pick<StoredAuth, 'nickname' | 'avatar' | 'userId'>>

const DECRYPT_ATTEMPTS = 3
const DECRYPT_RETRY_MS = 250

export class AuthCredentialStore {
  /** 解密结果：异步 API 无法同步取得，只在这里缓存一份，随载入 / 保存 / 清空更新 */
  private plainToken = ''

  constructor(
    private readonly cipher: TokenCipher,
    private readonly file: AuthFile,
    private readonly report: Reporter,
    private readonly onToken: (token: string) => void,
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  /** app.whenReady 之后调用：把磁盘凭证同步到内存；重复调用会重新解密（外部改动 / 单测重置） */
  async load(): Promise<void> {
    let stored: StoredAuth | null
    try {
      stored = this.file.read()
    }
    catch (error) {
      this.report('[pocket-auth] 凭证读取失败，按未登录处理', error)
      this.plainToken = ''
      return
    }
    if (!stored) {
      this.plainToken = ''
      return
    }
    if (!stored.tokenEnc) {
      this.plainToken = stored.tokenPlain || ''
      if (this.plainToken)
        this.onToken(this.plainToken)
      return
    }
    try {
      const { token, shouldReEncrypt } = await this.decryptWithRetry(stored.tokenEnc)
      this.plainToken = token
      if (token)
        this.onToken(token)
      if (shouldReEncrypt && token)
        await this.reEncrypt(token)
    }
    catch (error) {
      // 保留磁盘快照：档位 / 手机号仍可读，下次启动或重新登录还能恢复
      this.report('[pocket-auth] token 解密失败，按未登录处理', error)
      this.plainToken = ''
    }
  }

  /** 落盘快照（档位 / 手机号 / 资料）；读盘代价可忽略，登录与退出都不需要缓存失效 */
  getStored(): StoredAuth | null {
    return this.file.read()
  }

  /** 明文 token；磁盘无凭证、解密失败或已退出时为空串 */
  getToken(): string {
    return this.file.read() ? this.plainToken : ''
  }

  /** 保存新凭证；返回是否以系统加密落盘，false 表示明文降级 */
  async save(profile: Profile, token: string): Promise<boolean> {
    let available = false
    try {
      available = await this.cipher.isEncryptionAvailable()
    }
    catch (error) {
      this.report('[pocket-auth] 加密能力探测失败，本次按明文降级保存', error)
    }
    // 探测成功但加密失败不静默降级：把错误交给登录流程，避免 token 以明文意外落盘
    const tokenEnc = available ? await this.cipher.encrypt(token) : ''
    const tokenPlain = available ? '' : token
    this.file.write({ ...profile, tokenEnc, tokenPlain })
    this.plainToken = token
    return available
  }

  /** 资料回写（头像 / 昵称 / userId）；无变化不写盘，token 字段保持不动 */
  update(patch: ProfilePatch): void {
    const stored = this.file.read()
    if (!stored)
      return
    const keys = Object.keys(patch) as (keyof ProfilePatch)[]
    if (!keys.some(key => stored[key] !== patch[key]))
      return
    this.file.write({ ...stored, ...patch })
  }

  /** 退出 / token 失效：删文件并清空内存明文 */
  clear(): void {
    this.plainToken = ''
    this.file.remove()
  }

  private async decryptWithRetry(encoded: string): Promise<DecryptedToken> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.cipher.decrypt(encoded)
      }
      catch (error) {
        if (!(error instanceof TokenTemporarilyUnavailableError) || attempt >= DECRYPT_ATTEMPTS - 1)
          throw error
        await this.wait(DECRYPT_RETRY_MS * (attempt + 1))
      }
    }
  }

  /** 密钥轮换：用新密钥重加密并写回；失败时保留原密文，不影响本次会话的明文 token */
  private async reEncrypt(token: string): Promise<void> {
    try {
      const tokenEnc = await this.cipher.encrypt(token)
      const stored = this.file.read()
      if (!stored)
        return
      this.file.write({ ...stored, tokenEnc, tokenPlain: '' })
    }
    catch (error) {
      this.report('[pocket-auth] 密钥轮换后重新加密失败，保留原密文', error)
    }
  }
}
