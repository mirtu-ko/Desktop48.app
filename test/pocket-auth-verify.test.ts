import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkRoomAnswer,
  followMember,
  getAuthState,
  getFollowedIds,
  getRoomChannel,
  getRoomLastMessages,
  getRoomMessages,
  getServerChannels,
  MASTER_PASSCODE,
  unfollowMember,
  verifyLogin,
} from '../src/main/pocket48/pocket-auth'

/**
 * verifyLogin 的接口编排：token 校验 / IM 凭据 / 口袋钱包三个请求的
 * 失败隔离、字段兜底与资料回写。网络层用假 net 按 URL 分派响应。
 */

/** 假 net 的响应分派表：key 为 URL 匹配串；networkError=true 时触发 request error */
interface Env {
  requests: Array<{ url: string, body: Record<string, unknown>, headers: Record<string, string> }>
  stored: Record<string, unknown> | null
  written: Record<string, unknown> | null
  replies: Record<string, { status?: number, body?: unknown, networkError?: boolean }>
}

const env = vi.hoisted(() => ({
  requests: [] as Array<{ url: string, body: Record<string, unknown>, headers: Record<string, string> }>,
  stored: null as Record<string, unknown> | null,
  written: null as Record<string, unknown> | null,
  replies: {} as Record<string, { status?: number, body?: unknown, networkError?: boolean }>,
}) satisfies Env)

vi.mock('electron', () => {
  /** 模拟 net.request：end() 后异步回响应，与真实时序一致（response 事件在 data/end 之前） */
  const request = (options: { url: string }) => {
    const responseHandlers: Array<(response: unknown) => void> = []
    const errorHandlers: Array<(error: Error) => void> = []
    const headers: Record<string, string> = {}
    let body = ''
    return {
      setHeader: (key: string, value: string) => { headers[key] = value },
      write: (chunk: string) => { body += chunk },
      abort: vi.fn(),
      on: (event: string, callback: (argument: never) => void) => {
        if (event === 'response')
          responseHandlers.push(callback)
        else if (event === 'error')
          errorHandlers.push(callback)
      },
      end: () => {
        env.requests.push({ url: options.url, body: JSON.parse(body || '{}'), headers: { ...headers } })
        const reply = Object.entries(env.replies).find(([key]) => options.url.includes(key))?.[1]
          ?? { status: 200, body: { success: true } }
        setTimeout(() => {
          if (reply.networkError) {
            for (const callback of errorHandlers)
              callback(new Error('network down'))
            return
          }
          const dataHandlers: Array<(chunk: Buffer) => void> = []
          const endHandlers: Array<() => void> = []
          const response = {
            statusCode: reply.status ?? 200,
            on: (event: string, callback: (argument?: unknown) => void) => {
              if (event === 'data')
                dataHandlers.push(callback as (chunk: Buffer) => void)
              else if (event === 'end')
                endHandlers.push(callback as () => void)
            },
          }
          for (const callback of responseHandlers)
            callback(response)
          if (reply.body !== undefined) {
            const payload = Buffer.from(JSON.stringify(reply.body), 'utf8')
            for (const callback of dataHandlers)
              callback(payload)
          }
          for (const callback of endHandlers)
            callback()
        }, 0)
      },
    }
  }
  return {
    app: { getPath: () => '/tmp/pocket-auth-verify-test' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8'),
    },
    net: { request },
  }
})

vi.mock('../src/main/safe-json-file-sync', () => ({
  SafeJSONFileSync: class {
    read() { return env.stored }
    write(data: Record<string, unknown>) { env.written = data }
  },
}))

const STORED = {
  mobile: '13800138000',
  tokenEnc: '',
  tokenPlain: 'test-token',
  nickname: '旧昵称',
  avatar: 'https://example.com/old.png',
  userId: '10001',
  savedAt: 1_700_000_000_000,
}

/** 默认响应三件套：资料（扁平 content）+ IM 凭据 + 钱包 */
function defaultReplies() {
  return {
    'user/info/reload': {
      status: 200,
      body: {
        status: 200,
        success: true,
        content: {
          nickname: '新昵称',
          userId: 10002,
          avatar: 'https://example.com/new.png',
          level: 7,
          fansNum: 12345,
          likeCount: 678,
          signature: '今天也要元气满满',
        },
      },
    },
    'im/userinfo': {
      status: 200,
      body: { status: 200, success: true, content: { accid: 'acc-1', pwd: 'im-token' } },
    },
    'user/money': {
      status: 200,
      body: { status: 200, success: true, content: { moneyPay: 12.5, moneyFree: 3, moneyTotal: 15.5 } },
    },
  }
}

beforeEach(() => {
  env.requests.length = 0
  env.written = null
  env.stored = { ...STORED }
  env.replies = defaultReplies()
})

describe('pocket-auth verifyLogin', () => {
  it('验证通过时汇总服务端资料、社交数据与钱包余额', async () => {
    const result = await verifyLogin()
    expect(result.valid).toBe(true)
    expect(result.nickname).toBe('新昵称')
    expect(result.userId).toBe('10002')
    expect(result.level).toBe('7')
    expect(result.imOk).toBe(true)
    expect(result.imAccid).toBe('acc-1')
    expect(result.moneyOk).toBe(true)
    expect(result.moneyPay).toBe(12.5)
    expect(result.moneyFree).toBe(3)
    expect(result.moneyTotal).toBe(15.5)
    expect(result.fans).toBe('12345')
    expect(result.likes).toBe('678')
    expect(result.signature).toBe('今天也要元气满满')
    expect(result.message).toBe('登录有效')
    // 钱包接口与 48tools 一致：token 同时走请求头与请求体
    const moneyRequest = env.requests.find(r => r.url.includes('user/money'))
    expect(moneyRequest?.body).toEqual({ token: 'test-token' })
  })

  it('验证通过后用服务端最新资料回写本地凭证（token 不动）', async () => {
    await verifyLogin()
    expect(env.written).toMatchObject({
      nickname: '新昵称',
      avatar: 'https://example.com/new.png',
      userId: '10002',
      tokenPlain: 'test-token',
      savedAt: STORED.savedAt,
    })
  })

  it('资料无变化时不写盘', async () => {
    env.stored = { ...STORED, nickname: '新昵称', avatar: 'https://example.com/new.png', userId: '10002' }
    await verifyLogin()
    expect(env.written).toBeNull()
  })

  it('token 失效时直接判定过期，不再请求后续接口', async () => {
    env.replies['user/info/reload'] = { status: 200, body: { status: 401005, success: false, message: 'token 失效' } }
    const result = await verifyLogin()
    expect(result.valid).toBe(false)
    expect(result.message).toBe('登录已过期，请重新登录')
    expect(env.requests).toHaveLength(1)
  })

  it('未登录时直接返回未登录，不发任何请求', async () => {
    env.stored = null
    const result = await verifyLogin()
    expect(result.valid).toBe(false)
    expect(result.message).toBe('未登录口袋48账号')
    expect(env.requests).toHaveLength(0)
  })

  it('im 凭据失败时登录态仍有效，仅互动消息链路标记不可用', async () => {
    env.replies['im/userinfo'] = { status: 200, body: { status: 401005, success: false, message: 'im 挂了' } }
    const result = await verifyLogin()
    expect(result.valid).toBe(true)
    expect(result.imOk).toBe(false)
    expect(result.message).toContain('互动消息凭据获取失败')
  })

  it('钱包接口业务失败时静默降级，不影响登录态判定', async () => {
    env.replies['user/money'] = { status: 200, body: { status: 500, success: false, message: 'boom' } }
    const result = await verifyLogin()
    expect(result.valid).toBe(true)
    expect(result.moneyOk).toBe(false)
    expect(result.moneyTotal).toBe(0)
  })

  it('钱包接口网络异常时静默降级', async () => {
    env.replies['user/money'] = { networkError: true }
    const result = await verifyLogin()
    expect(result.valid).toBe(true)
    expect(result.moneyOk).toBe(false)
  })

  it('moneyTotal 缺失时用付费 + 免费兜底', async () => {
    env.replies['user/money'] = {
      status: 200,
      body: { status: 200, success: true, content: { moneyPay: 20, moneyFree: 5 } },
    }
    const result = await verifyLogin()
    expect(result.moneyOk).toBe(true)
    expect(result.moneyTotal).toBe(25)
  })

  it('社交字段缺失时返回空串，UI 据此隐藏对应条目', async () => {
    env.replies['user/info/reload'] = {
      status: 200,
      body: { status: 200, success: true, content: { nickname: '朴素用户', userId: 1, avatar: '' } },
    }
    const result = await verifyLogin()
    expect(result.fans).toBe('')
    expect(result.likes).toBe('')
    expect(result.signature).toBe('')
  })

  it('资料嵌在 userInfo 下时同样能提取（字段名逐个兜底）', async () => {
    env.replies['user/info/reload'] = {
      status: 200,
      body: {
        status: 200,
        success: true,
        content: { userInfo: { nickname: '嵌套昵称', userId: 9, avatar: '', level: 3, fansTimes: '88' } },
      },
    }
    const result = await verifyLogin()
    expect(result.nickname).toBe('嵌套昵称')
    expect(result.userId).toBe('9')
    expect(result.level).toBe('3')
    expect(result.fans).toBe('88')
  })

  it('登录态暴露凭证保存时间与脱敏手机号', () => {
    const state = getAuthState()
    expect(state.loggedIn).toBe(true)
    expect(state.savedAt).toBe(STORED.savedAt)
    expect(state.mobileMasked).toBe('138****8000')
  })
})

describe('pocket-auth 关注列表', () => {
  it('getFollowedIds 解析 content.data 并过滤脏值', async () => {
    env.replies['friendships/friends/id'] = {
      status: 200,
      body: { status: 200, success: true, content: { data: ['10001', 10002, 0, -1, null, 'abc'] } },
    }
    await expect(getFollowedIds()).resolves.toEqual([10001, 10002])
  })

  it('data 缺失时返回空数组', async () => {
    env.replies['friendships/friends/id'] = { status: 200, body: { status: 200, success: true, content: {} } }
    await expect(getFollowedIds()).resolves.toEqual([])
  })

  it('未登录返回空数组且不发请求', async () => {
    env.stored = null
    await expect(getFollowedIds()).resolves.toEqual([])
    expect(env.requests).toHaveLength(0)
  })

  it('token 失效抛「登录已过期」', async () => {
    env.replies['friendships/friends/id'] = { status: 200, body: { status: 401005, success: false } }
    await expect(getFollowedIds()).rejects.toThrow('登录已过期')
  })

  it('接口业务失败抛原始 message', async () => {
    env.replies['friendships/friends/id'] = { status: 200, body: { status: 200, success: false, message: '炸了' } }
    await expect(getFollowedIds()).rejects.toThrow('炸了')
  })

  it('关注 / 取关带 toSourceId 与 toType=1（yaya 同款）', async () => {
    env.replies['friendships/friends/add'] = { status: 200, body: { status: 200, success: true } }
    env.replies['friendships/friends/remove'] = { status: 200, body: { status: 200, success: true } }
    await followMember(10001)
    await unfollowMember(10001)
    const add = env.requests.find(r => r.url.includes('friends/add'))
    const remove = env.requests.find(r => r.url.includes('friends/remove'))
    expect(add?.body).toEqual({ toSourceId: 10001, toType: 1 })
    expect(remove?.body).toEqual({ toSourceId: 10001, toType: 1 })
  })

  it('关注业务失败抛错（调用方静默降级）', async () => {
    env.replies['friendships/friends/add'] = { status: 200, body: { status: 200, success: false, message: '已关注' } }
    await expect(followMember(10001)).rejects.toThrow('已关注')
  })

  it('未登录时关注直接抛错，不发请求', async () => {
    env.stored = null
    await expect(followMember(10001)).rejects.toThrow('未登录')
    expect(env.requests).toHaveLength(0)
  })
})

describe('pocket-auth 成员房间', () => {
  it('getRoomChannel：starId + targetType=1 解析出 serverId 与 channelId', async () => {
    env.replies['im/server/jump'] = {
      status: 200,
      body: { status: 200, success: true, content: { serverId: 888, channelId: 999 } },
    }
    await expect(getRoomChannel(10001)).resolves.toEqual({ serverId: '888', channelId: '999' })
    const request = env.requests.find(r => r.url.includes('im/server/jump'))
    expect(request?.body).toEqual({ starId: 10001, targetType: 1 })
  })

  it('getRoomChannel 未登录返回空频道，不发请求', async () => {
    env.stored = null
    await expect(getRoomChannel(10001)).resolves.toEqual({ serverId: '', channelId: '' })
    expect(env.requests).toHaveLength(0)
  })

  it('getRoomChannel token 失效抛「登录已过期」', async () => {
    env.replies['im/server/jump'] = { status: 200, body: { status: 401005, success: false } }
    await expect(getRoomChannel(10001)).rejects.toThrow('登录已过期')
  })

  it('getRoomMessages：四参请求体，解析 message 数组与 nextTime 游标', async () => {
    env.replies['team/message/list/homeowner'] = {
      status: 200,
      body: {
        status: 200,
        success: true,
        content: {
          nextTime: 123,
          message: [
            { msgIdServer: '1', msgIdClient: 'c1', msgType: 'TEXT', msgTime: 100, bodys: '你好', extInfo: '{}' },
            { msgIdServer: '2', msgIdClient: 'c2', msgType: 'IMAGE', msgTime: 200, bodys: '', extInfo: '' },
          ],
        },
      },
    }
    const result = await getRoomMessages('999', '888', 0)
    expect(result.nextTime).toBe(123)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toMatchObject({ msgIdClient: 'c1', msgType: 'TEXT', msgTime: 100, bodys: '你好' })
    const request = env.requests.find(r => r.url.includes('team/message/list/homeowner'))
    expect(request?.body).toEqual({ channelId: 999, serverId: 888, nextTime: 0, limit: 50 })
  })

  it('getRoomMessages：兼容 messageList 字段名并过滤脏条目', async () => {
    env.replies['team/message/list/homeowner'] = {
      status: 200,
      body: {
        status: 200,
        success: true,
        content: { nextTime: 0, messageList: [{ msgIdClient: 'c1', msgType: 'TEXT', msgTime: 1, bodys: 'hi' }, null, 'x'] },
      },
    }
    const result = await getRoomMessages('999', '888')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].msgIdClient).toBe('c1')
    // bodys/extInfo 非字符串时序列化兜底，渲染层 parseJson 仍可解析
    expect(result.messages[0].extInfo).toBe('{}')
  })

  it('getRoomMessages 未登录抛错，不发请求', async () => {
    env.stored = null
    await expect(getRoomMessages('999', '888')).rejects.toThrow('未登录')
    expect(env.requests).toHaveLength(0)
  })

  it('getRoomMessages 业务失败抛原始 message', async () => {
    env.replies['team/message/list/homeowner'] = { status: 200, body: { status: 200, success: false, message: '频道不存在' } }
    await expect(getRoomMessages('999', '888')).rejects.toThrow('频道不存在')
  })

  it('getRoomLastMessages：serverIdList 批量请求，解析 lastMsgList', async () => {
    env.replies['team/classic/last/message/get'] = {
      status: 200,
      body: {
        status: 200,
        success: true,
        content: {
          lastMsgList: [
            { channelId: '999', starName: '甲', msgContent: '{"messageType":"TEXT","text":"晚安"}', msgTime: 300, unreadCount: 2 },
            { channelId: '998', starName: '乙', msgContent: '在吗', msgTime: 200 },
            null,
          ],
        },
      },
    }
    const list = await getRoomLastMessages(['888', '887'])
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ channelId: '999', starName: '甲', msgTime: 300, unreadCount: 2 })
    expect(list[0].msgContent).toBe('{"messageType":"TEXT","text":"晚安"}')
    const request = env.requests.find(r => r.url.includes('team/classic/last/message/get'))
    expect(request?.body).toEqual({ serverIdList: [888, 887] })
  })

  it('getRoomLastMessages：空 serverIds 不发请求，返回空数组', async () => {
    await expect(getRoomLastMessages([])).resolves.toEqual([])
    await expect(getRoomLastMessages(['0', 'x'])).resolves.toEqual([])
    expect(env.requests).toHaveLength(0)
  })

  it('getRoomLastMessages token 失效抛「登录已过期」', async () => {
    env.replies['team/classic/last/message/get'] = { status: 200, body: { status: 401003, success: false } }
    await expect(getRoomLastMessages(['888'])).rejects.toThrow('登录已过期')
  })

  it('getRoomLastMessages 业务失败抛原始 message（调用方静默降级无预览）', async () => {
    env.replies['team/classic/last/message/get'] = { status: 200, body: { status: 200, success: false, message: '服务不存在' } }
    await expect(getRoomLastMessages(['888'])).rejects.toThrow('服务不存在')
  })
})

describe('pocket-auth checkRoomAnswer', () => {
  /** 真实校验端点（塞纳河48 反编译所得），见 pocket-auth.checkRoomAnswer 注释 */
  const VERIFY = 'team/channel/question/answer/verify'

  it('万能密码客户端直通：不发任何请求', async () => {
    await expect(checkRoomAnswer('40948216', '986', MASTER_PASSCODE)).resolves.toEqual({ ok: true, via: 'master' })
    expect(env.requests).toHaveLength(0)
  })

  it('空输入 / 缺题面：不发请求，按未通过返回', async () => {
    await expect(checkRoomAnswer('40948216', '986', '   '))
      .resolves
      .toMatchObject({ ok: false, reason: 'wrong', message: '请输入暗号' })
    await expect(checkRoomAnswer('40948216', '', '芝麻开门'))
      .resolves
      .toMatchObject({ ok: false, reason: 'wrong' })
    expect(env.requests).toHaveLength(0)
  })

  it('服务端 success 才算通过；questionId 按 long 传数字、answer 去首尾空白', async () => {
    env.replies[VERIFY] = { status: 200, body: { status: 200, success: true } }
    await expect(checkRoomAnswer('40948216', '986', ' 1126170193 ')).resolves.toEqual({ ok: true, via: 'server' })
    const request = env.requests.find(r => r.url.includes(VERIFY))
    expect(request?.body).toEqual({ answer: '1126170193', questionId: 986 })
  })

  it('服务端判错：透传服务端文案、reason=wrong', async () => {
    env.replies[VERIFY] = { status: 200, body: { status: 500, success: false, message: '回答错误' } }
    await expect(checkRoomAnswer('40948216', '986', 'zzz9'))
      .resolves
      .toMatchObject({ ok: false, reason: 'wrong', message: '回答错误' })
  })

  it('问题不存在（questionId 服务端不认）同样按判错返回，不用本地文案覆盖', async () => {
    env.replies[VERIFY] = { status: 200, body: { status: 500, success: false, message: '问题不存在' } }
    await expect(checkRoomAnswer('40948216', '999999', 'zzz9'))
      .resolves
      .toMatchObject({ ok: false, reason: 'wrong', message: '问题不存在' })
  })

  it('校验接口不可达时不冒充「回答错误」，返回 unverified', async () => {
    env.replies[VERIFY] = { status: 404, body: {} }
    await expect(checkRoomAnswer('40948216', '986', 'zzz9'))
      .resolves
      .toMatchObject({ ok: false, reason: 'unverified' })
  })

  it('token 失效上抛，不吞成校验失败', async () => {
    env.replies[VERIFY] = { status: 200, body: { status: 401005, success: false } }
    await expect(checkRoomAnswer('40948216', '986', 'zzz9')).rejects.toThrow('登录已过期')
  })
})

describe('pocket-auth 客户端身份（Android 档）', () => {
  /** 取某个已发出请求的请求头；找不到即抛（比非空断言给出更清楚的失败原因） */
  function headersOf(urlPart: string): Record<string, string> {
    const found = env.requests.find(item => item.url.includes(urlPart))
    if (!found)
      throw new Error(`未发出请求：${urlPart}`)
    return found.headers
  }

  it('主 App 与 seine 各取自己那份特征，平台均为 Android、设备 ID 同源同格式', async () => {
    await getRoomChannel(10001)
    await getServerChannels('1213951')

    // 主 App（pocket48）档：Android UA + 带空格的 UTF-8 Content-Type（与 iOS 档的紧写形式不同）
    const main = headersOf('im/api/v1/im/server/jump')
    expect(main['User-Agent'])
      .toBe('PocketFans201807/7.1.43_26082801 (23013RK75C:Android 14;Xiaomi UKQ1.231003.002 release-keys)')
    expect(main['Content-Type']).toBe('application/json; charset=UTF-8')
    const mainAppInfo = JSON.parse(main.appInfo)
    expect(mainAppInfo).toMatchObject({
      osType: 'android',
      osVersion: '14',
      appName: 'pocket48',
      deviceName: '23013RK75C',
    })
    // Android 档设备 ID 是 16 位小写 hex，且与 IMEI 同值
    expect(mainAppInfo.deviceId).toBe(mainAppInfo.IMEI)
    expect(mainAppInfo.deviceId).toMatch(/^[0-9a-f]{16}$/)

    // seine 档：独立客户端特征 + 专属 Device-Type 头
    const seine = headersOf('im/api/seine/server/detail')
    expect(seine['X-Custom-Device-Type']).toBe('ANDROID')
    expect(seine['User-Agent'])
      .toBe('PocketFans201807/1.3.4_26092001 (23013RK75C:Android 14;Xiaomi UKQ1.231003.002 release-keys)')
    const seineAppInfo = JSON.parse(seine.appInfo)
    expect(seineAppInfo).toMatchObject({
      osType: 'android',
      appName: 'seine48',
      appVersion: '1.3.4',
    })
    // 同一台设备：两档共用一个设备 ID（身份唯一来源的意义所在）
    expect(seineAppInfo.deviceId).toBe(mainAppInfo.deviceId)
  })

  it('两档特征都不自带 pa / token，由 postPocket 统一补（避免签名被覆盖）', async () => {
    await getRoomChannel(10001)
    await getServerChannels('1213951')
    // 两个请求都带上了签名与 token（由调用方补）
    for (const urlPart of ['im/api/v1/im/server/jump', 'im/api/seine/server/detail']) {
      const headers = headersOf(urlPart)
      expect(headers.pa).toBeTruthy()
      expect(headers.token).toBe('test-token')
    }
  })
})
