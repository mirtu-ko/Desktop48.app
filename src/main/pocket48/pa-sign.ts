/**
 * pocket48 请求签名（pa 头）动态生成。
 *
 * pa 是官方 App 的设备签名字段，格式为「当前毫秒时间戳 + 签名 + 版本号」。本模块加载
 * 官方 App 抽取的 wasm（resources/pocket48/2.wasm，约 52KB）现算现用，每次请求生成全新 pa；
 * 加载/生成失败时退回静态 pa，只影响签名新鲜度，不阻塞请求。
 *
 * wasm 是 Android APK 抽取件，故请求头平台也已统一为 Android（见 client-profile.ts）。
 */
import type { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { app } from 'electron'
import { debug, log } from '../logger'

interface PaWasmModule {
  default: (buffer: Buffer) => Promise<void>
  __x6c2adf8__: () => string
}

let wasm: PaWasmModule | null = null
let initPromise: Promise<void> | null = null

/** 惰性加载 wasm（进程内只跑一次）；失败只记日志，调用方走静态 pa 降级 */
export function ensurePaWasm(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        // resources/ 随包分发（asarUnpack 解出）；require 走 electron 的 asar 透明重定向，
        // dev（项目根）与打包后（app.asar.unpacked）都按 app 根路径可达
        const dir = path.join(app.getAppPath(), 'resources', 'pocket48')
        // 胶水是 wasm-bindgen 生成的 CommonJS 产物，必须 .cjs——项目 "type": "module" 下
        // .js 会被当 ESM 解析报 `module is not defined`（踩过）
        const wasmInit = createRequire(import.meta.url)(path.join(dir, 'rust-wasm.cjs')) as PaWasmModule
        await wasmInit.default(fs.readFileSync(path.join(dir, '2.wasm')))
        wasm = wasmInit
        debug('[pa-sign] wasm 加载成功，pa 动态生成已启用')
      }
      catch (error) {
        log('[pa-sign] wasm 加载失败，pa 退回静态签名（仅签名新鲜度不同，实测回包档位不受影响）', error)
      }
    })()
  }
  return initPromise
}

/** 生成当前请求的 pa：每次调用都是全新签名（内嵌当下时间戳）；wasm 不可用时退回 fallback */
export function currentPa(fallback: string): string {
  if (!wasm)
    return fallback
  try {
    return wasm.__x6c2adf8__()
  }
  catch (error) {
    log('[pa-sign] pa 生成失败，本次退回静态签名', error)
    return fallback
  }
}
