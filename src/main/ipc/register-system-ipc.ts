/**
 * 系统服务类 IPC 通道注册：路径/对话框/网络请求/ffmpeg 二进制检查。
 *
 * 这些通道的共同点是「无领域状态」——每次调用独立完成，不依赖模块级可变状态，
 * 因此可以直接内联实现而不必拆出业务模块。有状态的领域（数据库/直播流/任务）
 * 各自拥有独立的 register-*-ipc.ts 与业务模块。
 * 通道清单与渲染端 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import type { IpcMainInvokeEvent } from 'electron'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, net, shell } from 'electron'
import { isAllowedUrl } from '../allowed-hosts'
import { Database } from '../database'
import { handleTraced } from './trace'

// 网络请求 - 域名白名单校验
const NET_REQUEST_TIMEOUT = 20 * 1000
const NET_REQUEST_MAX_BYTES = 32 * 1024 * 1024

export function registerSystemIPC(): void {
  handleTraced('openPath', async (_event: IpcMainInvokeEvent, filePath: string) => {
    // 校验路径：允许系统标准用户目录 + 用户配置的下载目录/ffmpeg目录
    const allowedRoots = [
      app.getPath('desktop'),
      app.getPath('downloads'),
      app.getPath('documents'),
      app.getPath('videos'),
      app.getPath('pictures'),
      app.getPath('music'),
      app.getPath('userData'),
    ]
    for (const key of ['downloadDirectory', 'ffmpegDirectory']) {
      const dir = Database.instance().getConfig(key, '') as string
      if (dir)
        allowedRoots.push(dir)
    }
    const resolved = path.resolve(filePath)
    // 必须比较到分隔符边界，否则 Downloads_backup 会被误判为在 Downloads 之内；
    // Windows 路径大小写不敏感，统一转小写后比较
    const normalize = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
    const target = normalize(resolved)
    const inAllowedRoot = allowedRoots.some((root) => {
      const rootPath = normalize(path.resolve(root))
      return target === rootPath || target.startsWith(rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep)
    })
    if (!inAllowedRoot) {
      throw new Error(`路径不在允许范围内: ${filePath}`)
    }
    // openPath 以返回值（而非 reject）报告失败，必须 await 并检查，否则错误被静默丢弃
    const failure = await shell.openPath(resolved)
    if (failure)
      throw new Error(failure)
  })

  handleTraced('selectDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled)
      return null
    return result.filePaths[0]
  })

  handleTraced('pathJoin', (_event: IpcMainInvokeEvent, ...paths: string[]) => path.join(...paths))

  handleTraced('netRequest', async (_event: IpcMainInvokeEvent, options: any) => {
    const url: string = typeof options === 'string' ? options : options?.url
    if (!url || !isAllowedUrl(url)) {
      throw new Error(`请求被拒绝：域名不在白名单中 (${url})`)
    }
    return new Promise<string>((resolve, reject) => {
      const request = net.request(options)
      if (options.headers) {
        for (const key in options.headers)
          request.setHeader(key, options.headers[key])
      }

      let settled = false
      const timer = setTimeout(() => {
        if (settled)
          return
        settled = true
        request.abort()
        reject(new Error(`请求超时（${NET_REQUEST_TIMEOUT}ms）: ${url}`))
      }, NET_REQUEST_TIMEOUT)

      const fail = (err: Error) => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        reject(err)
      }
      const succeed = (data: string) => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        resolve(data)
      }

      request.on('response', (response) => {
        // 必须先收齐 Buffer 再整体解码：逐块 toString 会把跨块的 UTF-8 多字节字符切成乱码
        const chunks: Buffer[] = []
        let received = 0
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > NET_REQUEST_MAX_BYTES) {
            request.abort()
            fail(new Error(`响应体超过上限（${NET_REQUEST_MAX_BYTES} 字节）: ${url}`))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const status = response.statusCode
          if (status < 200 || status >= 300) {
            fail(new Error(`请求失败 HTTP ${status}: ${url}`))
            return
          }
          succeed(Buffer.concat(chunks).toString('utf8'))
        })
        response.on('aborted', () => fail(new Error(`响应被中断: ${url}`)))
        response.on('error', (err: Error) => fail(err))
      })
      request.on('abort', () => fail(new Error(`请求被中断: ${url}`)))
      request.on('error', fail)
      if (options.body)
        request.write(options.body)
      request.end()
    })
  })

  handleTraced('getDesktopPath', () => app.getPath('desktop'))

  // ffmpeg 相关
  handleTraced('checkFfmpegBinaries', async (_event: IpcMainInvokeEvent, dir: string) => {
    function ffmpegFullFilename(name: string): string {
      return process.platform === 'win32' ? `${name}.exe` : name
    }
    const ffmpegPath = path.join(dir, ffmpegFullFilename('ffmpeg'))
    const ffplayPath = path.join(dir, ffmpegFullFilename('ffplay'))
    if (!fs.existsSync(ffmpegPath))
      throw new Error('ffmpeg 不存在')
    if (!fs.existsSync(ffplayPath))
      throw new Error('ffplay 不存在')
    return true
  })
}
