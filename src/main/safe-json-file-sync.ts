import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { log } from './logger'

/**
 * database.json 的安全 JSON 存储：原子替换并在损坏时回退备份。
 *
 * rename 前必须 fsync，否则断电时数据可能尚未真正落盘。
 *
 * 写：open tmp → write → fsync → close → rename（同目录原子替换）
 * 读：主文件可解析则用之；解析失败则隔离为 .corrupt，回退 .bak
 * 备份：每次写入前，把"当前主文件"备份为 .bak，即上一版已知良好数据。
 *      若本次启动是从 .bak 恢复的（主文件损坏），第一次写入前禁止备份——
 *      否则损坏内容会覆盖掉唯一的好副本；写入成功后主文件即为好数据，恢复正常备份。
 */
export class SafeJSONFileSync<T> {
  private readonly tmpFile: string
  private readonly bakFile: string
  private readonly corruptFile: string
  /** 本次会话是否从 .bak 恢复过（主文件在首次成功写入前不可信） */
  private restoredFromBak = false

  constructor(private readonly filePath: string) {
    this.tmpFile = `${filePath}.${process.pid}.tmp`
    this.bakFile = `${filePath}.bak`
    this.corruptFile = `${filePath}.corrupt`
  }

  public read(): T | null {
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'))
        if (parsed && typeof parsed === 'object') {
          return parsed as T
        }
      }
      catch (error) {
        log('[safe-json-file-sync] 主文件解析失败，隔离并尝试回退 .bak', this.filePath, error)
        this.quarantineCorrupt()
        this.restoredFromBak = true
      }
    }
    if (existsSync(this.bakFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.bakFile, 'utf-8'))
        if (parsed && typeof parsed === 'object') {
          log('[safe-json-file-sync] 从 .bak 恢复数据库', this.bakFile)
          return parsed as T
        }
      }
      catch (error) {
        log('[safe-json-file-sync] .bak 也无法解析', this.bakFile, error)
      }
    }
    return null
  }

  public write(data: T): void {
    // 备份语义：主文件此刻是"上一版已知良好数据"。从 .bak 恢复后的首次写入除外，
    // 那时主文件还是损坏的，备份它会覆盖唯一好副本
    if (!this.restoredFromBak && existsSync(this.filePath)) {
      copyFileSync(this.filePath, this.bakFile)
    }
    this.restoredFromBak = false

    // tmp + fsync + rename 原子写：任何时刻崩溃，主文件要么是旧版要么是新版，不会是半截
    let fd: number | null = null
    try {
      fd = openSync(this.tmpFile, 'w')
      writeSync(fd, JSON.stringify(data))
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(this.tmpFile, this.filePath)
    }
    catch (error) {
      // 写入失败时清理 tmp，主文件保持旧版本不受影响
      try {
        if (fd !== null)
          closeSync(fd)
        if (existsSync(this.tmpFile))
          unlinkSync(this.tmpFile)
      }
      catch {}
      throw error
    }
  }

  /** 把损坏的主文件改名隔离（不删除，供人工排查），避免下次启动重复解析失败 */
  private quarantineCorrupt(): void {
    try {
      const target = existsSync(this.corruptFile)
        ? `${this.corruptFile}.${Date.now()}`
        : this.corruptFile
      copyFileSync(this.filePath, target)
      unlinkSync(this.filePath)
      log('[safe-json-file-sync] 损坏文件已隔离为', dirname(target))
    }
    catch (error) {
      log('[safe-json-file-sync] 隔离损坏文件失败', error)
    }
  }
}
