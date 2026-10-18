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
  loginByCode,
  loginByToken,
  MASTER_PASSCODE,
  sendSms,
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
      on: (event: string, callback: (argument: unknown) => void) => {
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

  it('频道列表 60s 内复用同一次请求，force 才重拉（渲染层取名字与主进程枚举共用）', async () => {
    const detailRequests = () => env.requests.filter(item => item.url.includes('seine/server/detail')).length
    await getServerChannels('9990001')
    expect(detailRequests()).toBe(1)
    // 同一次选中里两边各要一次：第二次直接吃缓存
    await getServerChannels('9990001')
    expect(detailRequests()).toBe(1)
    // 旧频道刚失效要立刻看新列表：force 绕过缓存
    await getServerChannels('9990001', true)
    expect(detailRequests()).toBe(2)
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

describe('pocket-auth 客户端身份（主 App Android 档 + seine Android 档）', () => {
  /** 取某个已发出请求的请求头；找不到即抛（比非空断言给出更清楚的失败原因） */
  function headersOf(urlPart: string): Record<string, string> {
    const found = env.requests.find(item => item.url.includes(urlPart))
    if (!found)
      throw new Error(`未发出请求：${urlPart}`)
    return found.headers
  }

  it('主 App 统一走 Android 档头，seine 保持独立 Android 特征', async () => {
    await getRoomChannel(10001)
    // force：频道列表有 60s 进程内缓存，这里要的是真实请求头
    await getServerChannels('1213951', true)

    // 主 App（pocket48）档：Android UA + 带空格 UTF-8 Content-Type。
    const main = headersOf('im/api/v1/im/server/jump')
    expect(main['User-Agent'])
      .toBe('PocketFans201807/7.1.44_26092001 (23013RK75C:Android 14;Xiaomi UKQ1.231003.002 release-keys)')
    expect(main['Content-Type']).toBe('application/json; charset=UTF-8')
    const mainAppInfo = JSON.parse(main.appInfo)
    expect(mainAppInfo).toMatchObject({
      vendor: 'Xiaomi',
      appName: 'pocket48',
      appVersion: '7.1.44',
      appBuild: '26092001',
      osType: 'android',
      osVersion: '14',
      deviceName: '23013RK75C',
    })
    // Android 档设备 ID 持久化为 16 位小写 IMEI 形状
    expect(mainAppInfo.deviceId).toMatch(/^[0-9a-f]{16}$/)

    // seine 档：独立 Android 客户端特征 + 专属 Device-Type 头（extraHeaders 全量覆盖主档）
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
  })

  it('两档特征都不自带 pa / token，由 postPocket 统一补（避免签名被覆盖）', async () => {
    await getRoomChannel(10001)
    // force：频道列表有 60s 进程内缓存，同文件的上一条用例刚拉过，这里要的是真实请求头
    await getServerChannels('1213951', true)
    // 两个请求都带上了签名与 token（由调用方补）
    for (const urlPart of ['im/api/v1/im/server/jump', 'im/api/seine/server/detail']) {
      const headers = headersOf(urlPart)
      expect(headers.pa).toBeTruthy()
      expect(headers.token).toBe('test-token')
    }
  })
})

/**
 * 区号支持：发码 / 登录 / 凭证落盘三处的 area 归一化与展示。
 * 网络层同样走假 net，断言请求体里的 area 与写盘的 area 字段。
 */
describe('pocket-auth 区号处理', () => {
  it('发码缺省区号时按 86 提交', async () => {
    env.replies['sms/send_sms'] = { status: 200, body: { status: 200, success: true, message: 'OK' } }
    await sendSms('13800138000')
    const request = env.requests.find(r => r.url.includes('sms/send_sms'))
    expect(request?.body).toEqual({ mobile: '13800138000', area: '86', businessCode: 1, intelligenceToken: '' })
  })

  it('发码区号带 + 前缀时归一化为纯数字', async () => {
    env.replies['sms/send_sms'] = { status: 200, body: { status: 200, success: true, message: 'OK' } }
    await sendSms('23000000', '+852')
    const request = env.requests.find(r => r.url.includes('sms/send_sms'))
    expect(request?.body).toEqual({ mobile: '23000000', area: '852', businessCode: 1, intelligenceToken: '' })
  })

  it('发码对 86 坚持 11 位，其他区号放宽到 4-15 位', async () => {
    env.replies['sms/send_sms'] = { status: 200, body: { status: 200, success: true, message: 'OK' } }
    await expect(sendSms('1380013800', '86')).rejects.toThrow('请输入 11 位手机号')
    await expect(sendSms('138001380000', '86')).rejects.toThrow('请输入 11 位手机号')
    await expect(sendSms('230', '852')).rejects.toThrow('请输入有效的手机号')
    await expect(sendSms('2300000000000000', '852')).rejects.toThrow('请输入有效的手机号')
    // 4 位与 15 位边界值放行
    await sendSms('2300', '852')
    await sendSms('230000000000000', '852')
    expect(env.requests).toHaveLength(2)
  })

  it('登录请求体带区号，凭证落盘记录同一区号', async () => {
    env.replies['login/app/app_login'] = {
      status: 200,
      body: { status: 200, success: true, content: { token: 'tok-1' } },
    }
    await loginByCode('23000000', '432613', '+852')
    const request = env.requests.find(r => r.url.includes('login/app/app_login'))
    expect(request?.body).toEqual({
      mobileCodeLogin: { mobile: '23000000', code: '432613', area: '852' },
      loginType: 'MOBILE_SMS_CODE',
      deviceToken: '',
    })
    expect(env.written).toMatchObject({ mobile: '23000000', area: '852', tokenPlain: 'tok-1' })
    // 落盘内容回读即为登录态展示（mock 的 write 不同步 stored，手动回灌；头 2 尾 2 脱敏）
    env.stored = { ...env.written } as Record<string, unknown>
    expect(getAuthState().mobileMasked).toBe('+852 23****00')
  })

  it('token 登录的手机号无区号语义，按 86 存档', async () => {
    await loginByToken('pasted-token', '13800138000')
    expect(env.written).toMatchObject({ mobile: '13800138000', area: '86' })
  })

  it('旧版凭证无 area 字段时按 86 展示，不带前缀', async () => {
    env.stored = { ...STORED }
    expect(getAuthState().mobileMasked).toBe('138****8000')
  })

  it('资料回写保留区号字段不丢', async () => {
    env.stored = { ...STORED, area: '852' }
    await verifyLogin()
    expect(env.written).toMatchObject({ area: '852', nickname: '新昵称' })
    expect(getAuthState().mobileMasked).toBe('+852 13****00')
  })
})

/**
 * 客户端身份档位：口袋48 / 塞纳河48 两个官方客户端档，决定请求头里的 appName、
 * UA 版本号与 Device-Type 头。同一账号可在两端并存，故档位是用户可见的功能开关，
 * 这里钉住「默认档 / 显式指定档 / 凭证决定的档 / 未知值回退」四条路径。
 */
describe('pocket-auth 客户端档位', () => {
  /** 从请求头还原该请求实际使用的身份特征 */
  function profileOf(request?: { headers: Record<string, string> }) {
    const appInfo = JSON.parse(request?.headers.appInfo || '{}') as Record<string, unknown>
    return {
      appName: appInfo.appName,
      appVersion: appInfo.appVersion,
      userAgent: request?.headers['User-Agent'] || '',
      deviceType: request?.headers['X-Custom-Device-Type'],
    }
  }

  it('无档位信息时（未登录 / 旧凭证）默认按口袋48档发请求', async () => {
    env.stored = { ...STORED }
    env.replies['sms/send_sms'] = { status: 200, body: { status: 200, success: true, message: 'OK' } }
    await sendSms('13800138000')
    const profile = profileOf(env.requests.find(r => r.url.includes('sms/send_sms')))
    expect(profile.appName).toBe('pocket48')
    expect(profile.appVersion).toBe('7.1.44')
    expect(profile.userAgent).toContain('PocketFans201807/7.1.44_26092001')
    expect(profile.deviceType).toBeUndefined()
  })

  it('显式指定塞纳河48档时，发码请求带该档特征头', async () => {
    env.replies['sms/send_sms'] = { status: 200, body: { status: 200, success: true, message: 'OK' } }
    await sendSms('13800138000', '86', undefined, 'seine48')
    const profile = profileOf(env.requests.find(r => r.url.includes('sms/send_sms')))
    expect(profile.appName).toBe('seine48')
    expect(profile.appVersion).toBe('1.3.4')
    expect(profile.userAgent).toContain('PocketFans201807/1.3.4_26092001')
    expect(profile.deviceType).toBe('ANDROID')
  })

  it('塞纳河48档登录：登录与随后的资料请求都用该档，档位随凭证落盘', async () => {
    env.replies['login/app/app_login'] = {
      status: 200,
      body: { status: 200, success: true, content: { token: 'tok-seine' } },
    }
    await loginByCode('13800138000', '432613', '86', 'seine48')
    // 登录链路里每个请求（含登录后补拉资料那个）都必须保持同一档
    expect(env.requests.length).toBeGreaterThan(1)
    for (const request of env.requests) {
      const profile = profileOf(request)
      expect(profile.appName).toBe('seine48')
      expect(profile.deviceType).toBe('ANDROID')
    }
    expect(env.written).toMatchObject({ clientProfile: 'seine48', tokenPlain: 'tok-seine' })
  })

  it('凭证里的档位决定后续所有请求的身份', async () => {
    env.stored = { ...STORED, clientProfile: 'seine48' }
    await verifyLogin()
    const profile = profileOf(env.requests.find(r => r.url.includes('user/info/reload')))
    expect(profile.appName).toBe('seine48')
    expect(profile.userAgent).toContain('PocketFans201807/1.3.4_26092001')
    expect(profile.deviceType).toBe('ANDROID')
  })

  it('token 登录按所选档落盘，并在登录态里回显', async () => {
    await loginByToken('pasted-token', '13800138000', 'seine48')
    expect(env.written).toMatchObject({ clientProfile: 'seine48' })
    // mock 的 write 不同步 stored，手动回灌后读登录态
    env.stored = { ...env.written } as Record<string, unknown>
    expect(getAuthState().clientProfile).toBe('seine48')
  })

  it('未知档位值回退口袋48（旧凭证 / 手改值容错）', () => {
    env.stored = { ...STORED, clientProfile: 'unknown-apk' }
    expect(getAuthState().clientProfile).toBe('pocket48')
  })
})
