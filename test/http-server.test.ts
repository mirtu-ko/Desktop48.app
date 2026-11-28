import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createLiveStreamRequestHandler,
  startLocalStreamServer,
  stopLocalStreamServer,
} from '../src/main/http-server'
import {
  assertLocalServerAvailable,
  getStreamServerPort,
  resetStreamServerState,
  STREAM_SERVER_MAX_PORT,
  STREAM_SERVER_MIN_PORT,
} from '../src/main/stream-server-state'

interface FakeFfmpeg extends EventEmitter {
  pid: number
  stdout: PassThrough
  killed: boolean
  killSignals: Array<string | undefined>
  kill: (signal?: NodeJS.Signals | number) => boolean
}

function createFakeFfmpeg(): FakeFfmpeg {
  const emitter = new EventEmitter() as FakeFfmpeg
  emitter.pid = 4242
  emitter.stdout = new PassThrough()
  emitter.killed = false
  emitter.killSignals = []
  emitter.kill = (signal?: NodeJS.Signals | number) => {
    emitter.killed = true
    emitter.killSignals.push(signal === undefined ? undefined : String(signal))
    return true
  }
  return emitter
}

function createFakeReq(url: string | undefined, headers: Record<string, string> = {}, method = 'GET') {
  const req = new EventEmitter() as http.IncomingMessage
  req.url = url
  req.method = method
  req.headers = headers
  return req
}

class FakeResponse extends Writable {
  statusCode = 0
  headersSent = false
  headers: Record<string, string | string[]> = {}
  chunks: Buffer[] = []
  ended = false

  setHeader(name: string, value: string | string[]) {
    this.headers[name.toLowerCase()] = value
  }

  writeHead(statusCode: number, headers?: Record<string, string | string[]>) {
    this.statusCode = statusCode
    this.headersSent = true
    if (headers) {
      for (const [k, v] of Object.entries(headers))
        this.headers[k.toLowerCase()] = v
    }
    return this
  }

  override _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.headersSent = true
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    callback()
  }

  override _final(callback: (error?: Error | null) => void) {
    this.ended = true
    callback()
  }

  bodyBuffer(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function createFakeRes() {
  return new FakeResponse() as FakeResponse & http.ServerResponse
}

class FakeHttpServer extends EventEmitter {
  listening = false
  listenCalls: Array<{ port: number, host: string }> = []
  closeCalls = 0
  onListen?: (port: number, host: string, server: FakeHttpServer) => void

  listen(port: number, host: string) {
    this.listenCalls.push({ port, host })
    this.onListen?.(port, host, this)
    return this
  }

  close() {
    this.closeCalls++
    this.listening = false
    return this
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetStreamServerState()
})

afterEach(() => {
  stopLocalStreamServer()
  resetStreamServerState()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('http-server（本地 HTTP-FLV 转流处理器）', () => {
  it('收到首块流数据后才发 200 video/x-flv 头并透传 FLV 二进制数据', () => {
    const ffmpeg = createFakeFfmpeg()
    const handler = createLiveStreamRequestHandler({
      createFlvStreamProcess: () => ffmpeg,
      idleTimeoutMs: 5_000,
    })

    const req = createFakeReq('/live/room1.flv', { origin: 'null' })
    const res = createFakeRes()
    handler(req, res)

    // 未收到首块流数据前，不能提前发 200 头
    expect(res.headersSent).toBe(false)

    ffmpeg.stdout.write(Buffer.from('FLV\x01\x05'))
    expect(res.headersSent).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('video/x-flv')

    ffmpeg.stdout.write(Buffer.from('\x00\x00\x00\x09'))
    ffmpeg.emit('close', 0, null)

    expect(res.ended).toBe(true)
    expect(res.bodyBuffer().equals(Buffer.from('FLV\x01\x05\x00\x00\x00\x09'))).toBe(true)
  })

  it('未出首帧即异常退出：返回 502 与错误文案', () => {
    const ffmpeg = createFakeFfmpeg()
    const handler = createLiveStreamRequestHandler({
      createFlvStreamProcess: () => ffmpeg,
      idleTimeoutMs: 5_000,
    })

    const res = createFakeRes()
    handler(createFakeReq('/live/room2.flv'), res)

    ffmpeg.emit('close', 1, null)

    expect(res.statusCode).toBe(502)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.bodyBuffer().toString('utf8')).toBe('Stream closed unexpectedly')
  })

  it('已发 200 FLV 头后异常退出：仅空结束，不向二进制流追加纯文本污染 FLV', () => {
    const ffmpeg = createFakeFfmpeg()
    const handler = createLiveStreamRequestHandler({
      createFlvStreamProcess: () => ffmpeg,
      idleTimeoutMs: 5_000,
    })

    const res = createFakeRes()
    handler(createFakeReq('/live/room3.flv'), res)

    const payload = Buffer.from('FLV\x01\x05binary-frame')
    ffmpeg.stdout.write(payload)
    ffmpeg.emit('close', 1, null)

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('video/x-flv')
    expect(res.bodyBuffer().equals(payload)).toBe(true)
    expect(res.bodyBuffer().toString('utf8')).not.toContain('Stream closed unexpectedly')
  })

  it('未出首帧空闲超时返回 504，并 SIGKILL 挂死进程', () => {
    const ffmpeg = createFakeFfmpeg()
    const handler = createLiveStreamRequestHandler({
      createFlvStreamProcess: () => ffmpeg,
      idleTimeoutMs: 1_000,
    })

    const res = createFakeRes()
    handler(createFakeReq('/live/room4.flv'), res)

    vi.advanceTimersByTime(1_000)

    expect(res.statusCode).toBe(504)
    expect(res.bodyBuffer().length).toBe(0)
    expect(ffmpeg.killSignals).toContain('SIGKILL')
  })

  it('已出首帧后空闲超时：空结束响应并 SIGKILL 进程', () => {
    const ffmpeg = createFakeFfmpeg()
    const handler = createLiveStreamRequestHandler({
      createFlvStreamProcess: () => ffmpeg,
      idleTimeoutMs: 1_000,
    })

    const res = createFakeRes()
    handler(createFakeReq('/live/room5.flv'), res)

    const payload = Buffer.from('FLV\x01\x05first-chunk')
    ffmpeg.stdout.write(payload)
    vi.advanceTimersByTime(1_000)

    expect(res.statusCode).toBe(200)
    expect(res.ended).toBe(true)
    expect(res.bodyBuffer().equals(payload)).toBe(true)
    expect(ffmpeg.killSignals).toContain('SIGKILL')
  })

  it('处理 Origin 403、OPTIONS 204、非法路径 400、无效路由 404 与建流抛错 500', () => {
    const handler = createLiveStreamRequestHandler({
      createFlvStreamProcess: () => {
        throw new Error('直播流不存在: room1')
      },
    })

    const forbidden = createFakeRes()
    handler(createFakeReq('/live/room1.flv', { origin: 'https://evil.example.com' }), forbidden)
    expect(forbidden.statusCode).toBe(403)

    const preflight = createFakeRes()
    handler(createFakeReq('/live/room1.flv', { origin: 'file://' }, 'OPTIONS'), preflight)
    expect(preflight.statusCode).toBe(204)

    const badPath = createFakeRes()
    handler(createFakeReq('/live/%E0%A4%A.flv'), badPath)
    expect(badPath.statusCode).toBe(400)

    const notFound = createFakeRes()
    handler(createFakeReq('/other/path.flv'), notFound)
    expect(notFound.statusCode).toBe(404)

    const spawnErr = createFakeRes()
    handler(createFakeReq('/live/room1.flv'), spawnErr)
    expect(spawnErr.statusCode).toBe(500)
    expect(spawnErr.bodyBuffer().toString('utf8')).toBe('直播流不存在: room1')
  })
})

describe('startLocalStreamServer / stopLocalStreamServer（端口退避与启停状态）', () => {
  it('端口 8080 被占时退避到 8081，停服后复位状态且支持幂等调用', () => {
    const fakeServer = new FakeHttpServer()
    fakeServer.onListen = (port, _host, srv) => {
      if (port === STREAM_SERVER_MIN_PORT) {
        const err = Object.assign(new Error('in use'), { code: 'EADDRINUSE' })
        srv.emit('error', err)
      }
      else {
        srv.listening = true
        srv.emit('listening')
      }
    }
    vi.spyOn(http, 'createServer').mockReturnValue(fakeServer as unknown as http.Server)

    const started = startLocalStreamServer(() => createFakeFfmpeg())
    expect(started).toBe(fakeServer)
    expect(fakeServer.listenCalls.map(c => c.port)).toEqual([8080, 8081])
    expect(getStreamServerPort()).toBe(8081)
    expect(() => assertLocalServerAvailable()).not.toThrow()

    // 幂等启动返回同一实例
    expect(startLocalStreamServer(() => createFakeFfmpeg())).toBe(fakeServer)

    // 停服关闭监听并复位端口状态；重复 stop 幂等
    stopLocalStreamServer()
    stopLocalStreamServer()
    expect(fakeServer.closeCalls).toBe(1)
    expect(getStreamServerPort()).toBe(STREAM_SERVER_MIN_PORT)
  })

  it('8080-8090 端口全部被占时标记耗尽并释放 activeServer', () => {
    const fakeServer = new FakeHttpServer()
    fakeServer.onListen = (_port, _host, srv) => {
      srv.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))
    }
    vi.spyOn(http, 'createServer').mockReturnValue(fakeServer as unknown as http.Server)

    startLocalStreamServer(() => createFakeFfmpeg())
    expect(fakeServer.listenCalls).toHaveLength(STREAM_SERVER_MAX_PORT - STREAM_SERVER_MIN_PORT + 1)
    expect(() => assertLocalServerAvailable()).toThrow('端口 8080-8090 均被占用')
  })

  it('非 EADDRINUSE 启动失败时标记服务不可用并释放 activeServer 以便后续重试', () => {
    const first = new FakeHttpServer()
    first.onListen = (_port, _host, srv) => {
      srv.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    }
    const second = new FakeHttpServer()
    second.onListen = (_port, _host, srv) => {
      srv.listening = true
      srv.emit('listening')
    }
    vi.spyOn(http, 'createServer')
      .mockReturnValueOnce(first as unknown as http.Server)
      .mockReturnValueOnce(second as unknown as http.Server)

    startLocalStreamServer(() => createFakeFfmpeg())
    expect(() => assertLocalServerAvailable()).toThrow('EACCES')

    // activeServer 已释放，再次启动可重新尝试并恢复可用
    expect(startLocalStreamServer(() => createFakeFfmpeg())).toBe(second)
    expect(() => assertLocalServerAvailable()).not.toThrow()
  })
})
