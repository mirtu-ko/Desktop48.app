import { Buffer } from 'node:buffer'
import { brotliCompressSync, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  buildDanmakuAuthBody,
  DANMAKU_OP_AUTH,
  DANMAKU_OP_HEARTBEAT,
  DANMAKU_OP_MESSAGE,
  DANMAKU_PROTOVER,
  extractDanmakuList,
  listMessageCommands,
  packDanmakuPacket,
  PACKET_HEADER_SIZE,
  unpackDanmakuPackets,
} from '../src/main/bilibili/danmaku-protocol'

/** 造一个任意 op / protover 的原始包，用于构造压缩外层与畸形包头 */
function rawPacket(op: number, protover: number, body: Buffer): Buffer {
  const header = Buffer.alloc(PACKET_HEADER_SIZE)
  header.writeUInt32BE(PACKET_HEADER_SIZE + body.length, 0)
  header.writeUInt16BE(PACKET_HEADER_SIZE, 4)
  header.writeUInt16BE(protover, 6)
  header.writeUInt32BE(op, 8)
  header.writeUInt32BE(1, 12)
  return Buffer.concat([header, body])
}

/** 造一个长度字段自相矛盾的包（包头长 / 总长任意指定） */
function malformedPacket(totalLength: number, headerLength: number, bodyLength: number): Buffer {
  const header = Buffer.alloc(PACKET_HEADER_SIZE)
  header.writeUInt32BE(totalLength, 0)
  header.writeUInt16BE(headerLength, 4)
  header.writeUInt16BE(1, 6)
  header.writeUInt32BE(DANMAKU_OP_MESSAGE, 8)
  header.writeUInt32BE(1, 12)
  return Buffer.concat([header, Buffer.alloc(bodyLength)])
}

/** 一条真实的 DANMU_MSG 消息包（cmd 带后缀，与服务端实际下发一致） */
function danmakuMessage(text: string, username: string): Buffer {
  const payload = { cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [[], text, [0, username]] }
  return packDanmakuPacket(JSON.stringify(payload), DANMAKU_OP_MESSAGE)
}

/** 造一条带表情的 DANMU_MSG：表情表在 info[0][15].extra（字符串化 JSON） */
function danmakuWithEmotes(text: string, emots: unknown, username = '张三') {
  const meta: unknown[] = []
  meta[15] = { extra: JSON.stringify({ content: text, emots }), mode: 0, show_player_type: 0, user: {} }
  return { cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [meta, text, [0, username]] }
}

const EMOTE_HTTP_20 = { url: 'http://i0.hdslb.com/bfs/live/abc.png', width: 20, height: 20 }

describe('packDanmakuPacket', () => {
  it('写出的包头字段与协议一致（总长 / 包头长 / 操作码 / 未压缩）', () => {
    const packet = packDanmakuPacket('{}', DANMAKU_OP_AUTH)

    expect(packet.readUInt32BE(0)).toBe(PACKET_HEADER_SIZE + 2)
    expect(packet.readUInt16BE(4)).toBe(PACKET_HEADER_SIZE)
    expect(packet.readUInt16BE(6)).toBe(1)
    expect(packet.readUInt32BE(8)).toBe(DANMAKU_OP_AUTH)
  })

  it('正文按 UTF-8 原样附加在包头之后', () => {
    const packet = packDanmakuPacket('你好', DANMAKU_OP_HEARTBEAT)

    expect(packet.subarray(PACKET_HEADER_SIZE).toString('utf8')).toBe('你好')
  })

  it('总长按字节数而非字符数计算（中文一字三字节）', () => {
    expect(packDanmakuPacket('你好', DANMAKU_OP_MESSAGE).readUInt32BE(0)).toBe(PACKET_HEADER_SIZE + 6)
  })
})

describe('unpackDanmakuPackets', () => {
  it('单个未压缩包解析出 op 与 JSON 正文', () => {
    const packets = unpackDanmakuPackets(danmakuMessage('hi', 'u1'))

    expect(packets).toHaveLength(1)
    expect(packets[0].op).toBe(DANMAKU_OP_MESSAGE)
    expect(packets[0].body).toMatchObject({ cmd: 'DANMU_MSG:4:0:2:2:2:0' })
  })

  it('一个帧里拼着的多个包全部解析', () => {
    const frame = Buffer.concat([danmakuMessage('a', 'u'), danmakuMessage('b', 'u')])

    expect(unpackDanmakuPackets(frame)).toHaveLength(2)
  })

  it('zlib 压缩包（protover 2）展开成内层包', () => {
    const outer = rawPacket(DANMAKU_OP_MESSAGE, 2, deflateSync(danmakuMessage('压缩', 'u')))

    const packets = unpackDanmakuPackets(outer)

    expect(packets).toHaveLength(1)
    expect(extractDanmakuList(packets[0].body)).toEqual([{ text: '压缩', username: 'u' }])
  })

  it('brotli 压缩包（protover 3）展开成内层包', () => {
    const outer = rawPacket(DANMAKU_OP_MESSAGE, 3, brotliCompressSync(danmakuMessage('压缩', 'u')))

    const packets = unpackDanmakuPackets(outer)

    expect(packets).toHaveLength(1)
    expect(extractDanmakuList(packets[0].body)).toEqual([{ text: '压缩', username: 'u' }])
  })

  it('压缩正文损坏时不抛，产出为空（宁可丢这一帧）', () => {
    const outer = rawPacket(DANMAKU_OP_MESSAGE, 3, Buffer.from('not brotli at all'))

    expect(() => unpackDanmakuPackets(outer)).not.toThrow()
    expect(unpackDanmakuPackets(outer)).toEqual([])
  })

  it('非 JSON 正文不抛，body 落为 null', () => {
    const packets = unpackDanmakuPackets(packDanmakuPacket('<html>', DANMAKU_OP_MESSAGE))

    expect(packets).toEqual([{ op: DANMAKU_OP_MESSAGE, body: null }])
  })

  it('非消息类操作码的 body 恒为 null（心跳应答等不解析）', () => {
    const packets = unpackDanmakuPackets(packDanmakuPacket('{"a":1}', 8))

    expect(packets).toEqual([{ op: 8, body: null }])
  })

  it('尾部不足一个包头时静默忽略，不产出垃圾包', () => {
    const good = danmakuMessage('ok', 'u')

    expect(unpackDanmakuPackets(Buffer.concat([good, Buffer.from([1, 2, 3])]))).toHaveLength(1)
  })

  it('包长超出缓冲区（半包）时丢弃该包及其后，前面已解析的包保留', () => {
    const good = danmakuMessage('ok', 'u')
    const truncated = good.subarray(0, good.length - 3)

    const packets = unpackDanmakuPackets(Buffer.concat([good, truncated]))

    expect(packets).toHaveLength(1)
    expect(extractDanmakuList(packets[0].body)).toEqual([{ text: 'ok', username: 'u' }])
  })

  it('包头长小于固定值时立即停止，不按错误偏移继续切', () => {
    const good = danmakuMessage('ok', 'u')

    expect(unpackDanmakuPackets(Buffer.concat([good, malformedPacket(20, 8, 4)]))).toHaveLength(1)
    expect(unpackDanmakuPackets(malformedPacket(20, 8, 4))).toEqual([])
  })

  it('总长小于包头长时立即停止', () => {
    expect(unpackDanmakuPackets(malformedPacket(8, PACKET_HEADER_SIZE, 0))).toEqual([])
  })

  it('空缓冲区返回空数组', () => {
    expect(unpackDanmakuPackets(Buffer.alloc(0))).toEqual([])
  })
})

describe('extractDanmakuList', () => {
  it('单条弹幕取 info[1] 文本与 info[2][1] 用户名', () => {
    const payload = { cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [[], '晚上好', [0, '张三']] }

    expect(extractDanmakuList(payload)).toEqual([{ text: '晚上好', username: '张三' }])
  })

  it('数组正文按序取出全部弹幕', () => {
    const payload = [
      { cmd: 'DANMU_MSG', info: [[], 'a', [0, 'u1']] },
      { cmd: 'DANMU_MSG:4:0', info: [[], 'b', [0, 'u2']] },
    ]

    expect(extractDanmakuList(payload)).toEqual([
      { text: 'a', username: 'u1' },
      { text: 'b', username: 'u2' },
    ])
  })

  it('只认 DANMU_MSG 主指令，进场 / 人气 / 榜单一律丢弃', () => {
    const payload = [
      { cmd: 'DANMU_MSG', info: [[], 'keep', [0, 'u']] },
      { cmd: 'INTERACT_WORD', info: [[], 'drop', [0, 'u']] },
      // 前缀相同但不是同一指令，不得被子串命中
      { cmd: 'DANMU_MSG_EXTRA', info: [[], 'drop', [0, 'u']] },
      { cmd: 'ONLINE_RANK_COUNT', info: [[], 'drop'] },
    ]

    expect(extractDanmakuList(payload)).toEqual([{ text: 'keep', username: 'u' }])
  })

  it('cmd 缺失 / 非字符串 / info 非数组一律丢弃', () => {
    expect(extractDanmakuList({ info: [[], 'x', [0, 'u']] })).toEqual([])
    expect(extractDanmakuList({ cmd: 1, info: [[], 'x', [0, 'u']] })).toEqual([])
    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: 'nope' })).toEqual([])
    expect(extractDanmakuList({ cmd: 'DANMU_MSG' })).toEqual([])
  })

  it('空文本不产出（服务端偶发空弹幕）', () => {
    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: [[], '', [0, 'u']] })).toEqual([])
    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: [[], null, [0, 'u']] })).toEqual([])
  })

  it('用户名缺失时落为空串，弹幕本身仍保留', () => {
    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: [[], 'x'] })).toEqual([{ text: 'x', username: '' }])
    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: [[], 'x', [0, 42]] })).toEqual([{ text: 'x', username: '' }])
  })

  it('null / 基本类型正文不抛', () => {
    expect(extractDanmakuList(null)).toEqual([])
    expect(extractDanmakuList('nope')).toEqual([])
    expect(extractDanmakuList([null, 1, 'x'])).toEqual([])
  })
})

describe('extractDanmakuList / 表情（info[0][15].extra.emots）', () => {
  it('取出表情图地址与尺寸，图片地址统一升级为 https', () => {
    const payload = danmakuWithEmotes('白花300块[热]', { '[热]': EMOTE_HTTP_20 })

    expect(extractDanmakuList(payload)).toEqual([{
      text: '白花300块[热]',
      username: '张三',
      emots: { '[热]': { url: 'https://i0.hdslb.com/bfs/live/abc.png', width: 20, height: 20 } },
    }])
  })

  it('尺寸缺失或非正 / 非有限时按 20×20 兜底', () => {
    const missing = danmakuWithEmotes('x[热]', { '[热]': { url: 'http://a/b.png' } })
    const invalid = danmakuWithEmotes('x[热]', {
      '[热]': { url: 'http://a/b.png', width: Number.POSITIVE_INFINITY, height: -1 },
    })

    expect(extractDanmakuList(missing)[0].emots?.['[热]']).toEqual({
      url: 'https://a/b.png',
      width: 20,
      height: 20,
    })
    expect(extractDanmakuList(invalid)[0].emots?.['[热]']).toMatchObject({ width: 20, height: 20 })
  })

  it('没有表情时不含 emots 键（渲染层据此保持纯文本）', () => {
    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: [[], '晚上好', [0, '张三']] }))
      .toEqual([{ text: '晚上好', username: '张三' }])
  })

  it('info[0][15] 不存在（老格式）时不抛，退回纯文本', () => {
    const meta: unknown[] = []

    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: [meta, 'x', [0, 'u']] }))
      .toEqual([{ text: 'x', username: 'u' }])
    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: [[undefined, 1, 2], 'x', [0, 'u']] }))
      .toEqual([{ text: 'x', username: 'u' }])
  })

  it('extra 不是合法 JSON 时退回纯文本，弹幕本身仍保留', () => {
    const meta: unknown[] = []
    meta[15] = { extra: '{坏 JSON' }

    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: [meta, 'x', [0, 'u']] }))
      .toEqual([{ text: 'x', username: 'u' }])
  })

  it('emots 非对象 / 条目缺 url / 键为空时逐条跳过，全无效则退回纯文本', () => {
    expect(extractDanmakuList(danmakuWithEmotes('x', 'nope'))).toEqual([{ text: 'x', username: '张三' }])
    expect(extractDanmakuList(danmakuWithEmotes('x', { '[热]': { width: 20 } })))
      .toEqual([{ text: 'x', username: '张三' }])
    expect(extractDanmakuList(danmakuWithEmotes('x', { '': EMOTE_HTTP_20 })))
      .toEqual([{ text: 'x', username: '张三' }])
  })

  it('部分条目无效时只保留有效的那些', () => {
    const payload = danmakuWithEmotes('x[热]', { '[热]': EMOTE_HTTP_20, '[坏]': { width: 20 } })

    expect(Object.keys(extractDanmakuList(payload)[0].emots ?? {})).toEqual(['[热]'])
  })
})

describe('extractDanmakuList / 装扮表情（info[0][13]）', () => {
  /** 真实抓包形态：大表情的 extra.emots 是 null，数据在 info[0][13] 这个对象里 */
  function bulgePayload(text: string, unique: string) {
    const meta: unknown[] = []
    meta[13] = {
      bulge_display: 1,
      emoticon_unique: unique,
      height: 20,
      in_player_area: 1,
      is_dynamic: 0,
      url: 'https://i0.hdslb.com/bfs/garb/3c1f2a83bc427edfd5b9f1a586cffeac19165e9d.png',
      width: 20,
    }
    meta[15] = { extra: JSON.stringify({ content: text, dm_type: 1, emots: null }) }
    return { cmd: 'DANMU_MSG', info: [meta, text, [0, '鲮某']] }
  }

  it('名字从 emoticon_unique 的方括号里取，地址与尺寸照用', () => {
    const text = '[四禧丸子·溯梦幻境_恬豆点赞]'

    expect(extractDanmakuList(bulgePayload(text, `upower_${text}`))).toEqual([{
      text,
      username: '鲮某',
      emots: {
        [text]: {
          url: 'https://i0.hdslb.com/bfs/garb/3c1f2a83bc427edfd5b9f1a586cffeac19165e9d.png',
          width: 20,
          height: 20,
        },
      },
    }])
  })

  it('普通弹幕的 info[0][13] 是空 JSON 串，不产出表情', () => {
    const meta: unknown[] = []
    meta[13] = '{}'
    meta[15] = { extra: JSON.stringify({ content: 'x', emots: null }) }

    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: [meta, 'x', [0, 'u']] }))
      .toEqual([{ text: 'x', username: 'u' }])
  })

  it('emoticon_unique 里没有方括号时退回用整条文本当键', () => {
    const meta: unknown[] = []
    meta[13] = { emoticon_unique: 'upower_no-bracket', url: 'https://a/b.png' }

    const payload = { cmd: 'DANMU_MSG', info: [meta, '[怪表情]', [0, 'u']] }

    expect(Object.keys(extractDanmakuList(payload)[0].emots ?? {})).toEqual(['[怪表情]'])
  })

  it('缺 url 时不产出（不猜）', () => {
    const meta: unknown[] = []
    meta[13] = { emoticon_unique: 'upower_[热]', width: 20 }

    expect(extractDanmakuList({ cmd: 'DANMU_MSG', info: [meta, '[热]', [0, 'u']] }))
      .toEqual([{ text: '[热]', username: 'u' }])
  })
})

describe('buildDanmakuAuthBody', () => {
  it('未登录鉴权：uid 0、buvid 原样带入、请求 brotli 正文', () => {
    expect(JSON.parse(buildDanmakuAuthBody(63727, 'token-abc', 'BUVID-X'))).toEqual({
      uid: 0,
      roomid: 63727,
      protover: DANMAKU_PROTOVER,
      buvid: 'BUVID-X',
      platform: 'web',
      type: 2,
      key: 'token-abc',
    })
  })

  it('buvid 非空才发得出去：空值会被服务端降级，这里不替调用方兜底', () => {
    // 反向验证：把 buvid 写死成 '' 会让上一条用例转红
    expect(JSON.parse(buildDanmakuAuthBody(63727, 'token-abc', '')).buvid).toBe('')
  })

  it('房间号与 token 逐次带入，不残留上次的值', () => {
    const body = JSON.parse(buildDanmakuAuthBody(391199, 'other', 'BUVID-Y'))

    expect(body.roomid).toBe(391199)
    expect(body.key).toBe('other')
    expect(body.buvid).toBe('BUVID-Y')
  })
})

describe('listMessageCommands（诊断：摊开被丢弃的指令名）', () => {
  it('取主指令名，冒号后缀被截掉', () => {
    expect(listMessageCommands({ cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [] })).toEqual(['DANMU_MSG'])
  })

  it('数组正文按序取出全部指令名', () => {
    const payload = [
      { cmd: 'DANMU_MSG', info: [] },
      { cmd: 'INTERACT_WORD', info: [] },
    ]

    expect(listMessageCommands(payload)).toEqual(['DANMU_MSG', 'INTERACT_WORD'])
  })

  it('无 cmd / 非对象条目跳过，不抛', () => {
    expect(listMessageCommands([null, 1, 'x', { info: [] }, { cmd: 42 }])).toEqual([])
  })

  it('与 extractDanmakuList 互补：后者认不出的指令，这里能拿到名字', () => {
    const payload = { cmd: 'SUPER_CHAT_MESSAGE', info: [] }

    expect(extractDanmakuList(payload)).toEqual([])
    expect(listMessageCommands(payload)).toEqual(['SUPER_CHAT_MESSAGE'])
  })
})
