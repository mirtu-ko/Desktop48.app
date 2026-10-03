import { describe, expect, it } from 'vitest'
import {
  isAllowedBilibiliApiUrl,
  isAllowedBilibiliSocketUrl,
  isAllowedStreamUrl,
  isAllowedUrl,
} from '../src/main/allowed-hosts'

describe('isAllowedUrl', () => {
  it('放行白名单内的精确域名', () => {
    expect(isAllowedUrl('https://pocketapi.48.cn/api/getInfo')).toBe(true)
    expect(isAllowedUrl('https://www.cgt48.com/')).toBe(true)
    expect(isAllowedUrl('https://b50.ckg48.com/')).toBe(true)
    expect(isAllowedUrl('http://live.48.cn/live/1.flv')).toBe(true)
  })

  it('按域名后缀放行动态下发的媒体域名', () => {
    expect(isAllowedUrl('https://al.hls.xiaoka.48.cn/stream.m3u8')).toBe(true)
    expect(isAllowedUrl('https://cdn.example.snh48.com/v.mp4')).toBe(true)
  })

  it('拒绝外部域名', () => {
    expect(isAllowedUrl('https://evil.com/api')).toBe(false)
    // 后缀匹配必须以 .48.cn 结尾，而不是包含 48.cn
    expect(isAllowedUrl('https://48.cn.evil.com/api')).toBe(false)
  })

  it('拒绝非 http/https 协议', () => {
    expect(isAllowedUrl('ftp://pocketapi.48.cn/file')).toBe(false)
    expect(isAllowedUrl('file:///etc/passwd')).toBe(false)
  })

  it('非法 URL 返回 false 而非抛错', () => {
    expect(isAllowedUrl('not a url')).toBe(false)
    expect(isAllowedUrl('')).toBe(false)
  })
})

describe('isAllowedStreamUrl（ffmpeg 输入地址校验）', () => {
  it('放行 rtmp 拉流地址（白名单后缀域名）', () => {
    expect(isAllowedStreamUrl('rtmp://alcdn.live.48.cn/live/stream_123')).toBe(true)
  })

  it('放行 http/https 回放与录制源（与 netRequest 同一套 HTTP 白名单）', () => {
    expect(isAllowedStreamUrl('https://al.hls.xiaoka.48.cn/stream.m3u8')).toBe(true)
    expect(isAllowedStreamUrl('http://ts.48.cn/live/123/playlist.m3u8')).toBe(true)
  })

  it('拒绝外部域名的 rtmp 与 http 地址', () => {
    expect(isAllowedStreamUrl('rtmp://evil.com/live/stream')).toBe(false)
    expect(isAllowedStreamUrl('https://evil.com/stream.m3u8')).toBe(false)
    // 后缀匹配必须以 .48.cn 结尾，而不是包含 48.cn
    expect(isAllowedStreamUrl('rtmp://48.cn.evil.com/live/stream')).toBe(false)
  })

  it('拒绝非 rtmp/http/https 协议（file://、ftp:// 等）', () => {
    expect(isAllowedStreamUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedStreamUrl('ftp://pocketapi.48.cn/file')).toBe(false)
  })

  it('非法 URL 返回 false 而非抛错', () => {
    expect(isAllowedStreamUrl('not a url')).toBe(false)
    expect(isAllowedStreamUrl('')).toBe(false)
  })
})

describe('isAllowedBilibiliApiUrl（弹幕握手接口）', () => {
  it('放行 WBI / 房间信息 / 弹幕服务器列表 / 设备指纹这几个接口', () => {
    expect(isAllowedBilibiliApiUrl('https://api.bilibili.com/x/web-interface/nav')).toBe(true)
    expect(isAllowedBilibiliApiUrl('https://api.bilibili.com/x/frontend/finger/spi')).toBe(true)
    expect(isAllowedBilibiliApiUrl('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=48')).toBe(true)
    expect(isAllowedBilibiliApiUrl('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=63727')).toBe(true)
  })

  it('拒绝 B 站的其它域名（白名单只覆盖握手用到的三个）', () => {
    expect(isAllowedBilibiliApiUrl('https://live.bilibili.com/48')).toBe(false)
    expect(isAllowedBilibiliApiUrl('https://www.bilibili.com/video/BV1')).toBe(false)
  })

  it('不放行本项目的 48 系域名（两套白名单互相隔离）', () => {
    expect(isAllowedBilibiliApiUrl('https://pocketapi.48.cn/api/getInfo')).toBe(false)
  })

  it('拒绝子域名仿冒与非 http(s) 协议', () => {
    expect(isAllowedBilibiliApiUrl('https://api.bilibili.com.evil.com/x')).toBe(false)
    expect(isAllowedBilibiliApiUrl('wss://api.bilibili.com/x')).toBe(false)
    expect(isAllowedBilibiliApiUrl('not a url')).toBe(false)
  })
})

describe('isAllowedBilibiliSocketUrl（弹幕长连接）', () => {
  it('放行 .chat.bilibili.com 下的动态下发服务器', () => {
    expect(isAllowedBilibiliSocketUrl('wss://broadcastlv.chat.bilibili.com:443/sub')).toBe(true)
    expect(isAllowedBilibiliSocketUrl('wss://tx-bj-live-comet-02.chat.bilibili.com:443/sub')).toBe(true)
  })

  it('后缀必须带点边界，仿冒域名不放行', () => {
    expect(isAllowedBilibiliSocketUrl('wss://evil-chat.bilibili.com/sub')).toBe(false)
    expect(isAllowedBilibiliSocketUrl('wss://chat.bilibili.com.evil.com/sub')).toBe(false)
    expect(isAllowedBilibiliSocketUrl('wss://evil.com/sub')).toBe(false)
  })

  it('不放行非弹幕域名，也不放行本项目域名（不并入 netRequest 的放行集合）', () => {
    expect(isAllowedBilibiliSocketUrl('wss://api.live.bilibili.com/sub')).toBe(false)
    expect(isAllowedBilibiliSocketUrl('wss://live.48.cn/sub')).toBe(false)
  })

  it('拒绝非 ws(s) 协议', () => {
    expect(isAllowedBilibiliSocketUrl('https://broadcastlv.chat.bilibili.com/sub')).toBe(false)
    expect(isAllowedBilibiliSocketUrl('not a url')).toBe(false)
  })
})
