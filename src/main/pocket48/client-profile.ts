import type { PocketClientProfileId } from '@common/pocket-client-profile'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { ANDROID_DEVICE } from '@common/android-device'
import { DEFAULT_POCKET_CLIENT_PROFILE } from '@common/pocket-client-profile'
import { app } from 'electron'
import { log } from '../logger'
import { SafeJSONFileSync } from '../safe-json-file-sync'

/**
 * 口袋系客户端的设备身份与请求特征，**唯一来源**（pocket-auth 与 nim-chatroom 共用）。
 *
 * 客户端档位（用户可选）：`POCKET_CLIENT_PROFILES` 是「档位 → 特征」的唯一映射，
 * 档位 id 与展示文案见 `common/pocket-client-profile.ts`。用户在登录时选定档位，档位随凭证落盘，
 * 此后主进程所有请求按该档发头。
 *
 * 档位只是**客户端指纹**，不改变账号身份：两档用同一个 pocketapi 账号取凭据，
 * 拿到的 `accid` 与 `userId` 完全相同。
 *
 * 平台分档现状：口袋主 App 已切到 v2 登录域并与 seine / 云信统一为
 * **Android** 档，v2 验证码登录实测成功：
 * - `pa` 由官方 Android APK 抽出的 wasm 现算（resources/pocket48/2.wasm）；
 * - 云信聊天室只能以移动端身份登录（Web SDK 被服务端 403 拒），现有实现本就是 Android 报文；
 * - 聊天室的 SDK 版本与包名也随档位（`nim` 字段）——HTTP 与 TCP 报同一家客户端，
 *   档位才是完整口径，不再出现「口袋 HTTP 头 + seine 聊天室身份」的混搭；
 * - 口袋 HTTP 头：Android 档（pocket-auth.ts 复用本文件）；seine48 为 Android 档。
 *
 * 字段名照抄参考实现 yaya_msg 的真实设备模拟；主 App 版本号取官方 7.1.44 APK。
 * 切换平台前逐接口做过 A/B：
 * 同 token、同 pa，只换 iOS 档与 Android 档对比——关注名单、用户域（登录态校验）、登录发码、
 * 房间频道 jump、批量预览、房间消息、频道归属、频道名、IM 凭据，全部 HTTP 200 且
 * success / status / 关键字段集一致（脚本 D:/DEV/48/probe-profile.mjs，属分析目录不入库）。
 *
 * 机型（2026-10-16）由参考实现那台 Samsung S10 换成国内保有量更大的**红米 K60**，
 * 设备事实见 `common/android-device.ts`——站点档的浏览器 UA 同源，两处不再是两台设备。
 *
 * 设备 ID（appInfo 的 `IMEI` / `deviceId`）**持久化**在 `userData/pocket48-device.json`，
 * 进程内再缓存一层：跨会话复用同一台设备。每次启动换新 ID 对服务端等价于一次重装，
 * 会让按设备维度的风控 / 统计失真。文件与登录存档分开存放，避免污染 verifyLogin 的
 * 「无变化不写盘」语义。格式必须随平台——Android 档为 16 位小写 hex（IMEI 形状，
 * 由 UUID 抽 hex 而来），`IMEI` 与 `deviceId` 取同一个值；不要改回大写 UUID。
 */

/** 设备 ID 的持久化文件（userData 下，与 pocket48-auth.json 等各存各的） */
const DEVICE_FILE_NAME = 'pocket48-device.json'

/** 设备 ID 的形状约定：Android 档的 IMEI 形状（16 位小写 hex） */
const DEVICE_ID_PATTERN = /^[0-9a-f]{16}$/

interface StoredDevice {
  deviceId: string
}

let cachedDeviceId = ''
let deviceStore: SafeJSONFileSync<StoredDevice> | null = null

/** 惰性创建持久化句柄：`app.getPath` 在应用 ready 前不可用；存储不可用时返回 null，调用方退回内存 ID */
function store(): SafeJSONFileSync<StoredDevice> | null {
  if (!deviceStore) {
    try {
      deviceStore = new SafeJSONFileSync<StoredDevice>(path.join(app.getPath('userData'), DEVICE_FILE_NAME))
    }
    catch (error) {
      log('[client-profile] 设备 ID 存储不可用，本次会话改用内存 ID', error)
      return null
    }
  }
  return deviceStore
}

/** 新设备 ID：由 UUID 抽 hex 得到 16 位小写串（对齐 Android 档的 IMEI 形状） */
function createDeviceId(): string {
  return randomUUID().replace(/[^a-f0-9]/gi, '').slice(0, 16).toLowerCase() || '0000000000000000'
}

/**
 * 伪装设备 ID：读盘复用 → 命中即用；缺失 / 值不合法（手改、旧格式）则重建并写回。
 * 进程内缓存保证同一会话内多次调用返回同一值（HTTP 两档与聊天室因此是同一台设备）。
 */
export function pocketDeviceId(): string {
  if (cachedDeviceId)
    return cachedDeviceId

  const file = store()
  const stored = file?.read()
  if (typeof stored?.deviceId === 'string' && DEVICE_ID_PATTERN.test(stored.deviceId)) {
    cachedDeviceId = stored.deviceId
    return cachedDeviceId
  }

  cachedDeviceId = createDeviceId()
  try {
    file?.write({ deviceId: cachedDeviceId })
  }
  catch (error) {
    // 落盘失败不阻断请求：本次会话仍用同一个 ID，下次启动会再试一次
    log('[client-profile] 设备 ID 落盘失败，本次会话内存内复用', error)
  }
  return cachedDeviceId
}

/**
 * 云信聊天室登录身份（TCP 私有协议，非 HTTP）：登录属性表里的 SDK 版本与包名。
 * 数值与包名必须取自**同一个 APK**，混搭会得到一个任何真实客户端都不存在的身份。
 */
export interface NimClientIdentity {
  /** 登录属性 6 / LBS 请求的 `v` 参数：云信 Android SDK 版本号（如 92012） */
  sdkVersion: number
  /** 登录属性 25：客户端包名 */
  packageName: string
}

/** 单档客户端特征：公共请求头与 appInfo 的取值来源 */
export interface PocketClientProfile {
  /**
   * Android 档的 Content-Type 带空格且 UTF-8 大写（`application/json; charset=UTF-8`），
   * 与 iOS 档的紧写形式不同——这是实测到的真实差异，照抄勿「顺手统一」。
   */
  contentType: string
  userAgent: string
  /** appInfo 头的内容：以设备 ID 为入参返回对象（键顺序与实测回包一致，勿随意调整） */
  appInfo: (deviceId: string) => Record<string, string | number>
  /** 该客户端独有的额外头（如 seine 的 X-Custom-Device-Type） */
  extraHeaders?: Record<string, string>
  /**
   * 云信聊天室身份。**必须与本档同源**：HTTP 报哪家的客户端特征，TCP 就该报哪家的
   * SDK 版本与包名——选口袋档即「全口径口袋客户端」，聊天室也不例外。
   * 取用见 `nim-chatroom.ts`（握手与 LBS 请求都读这一份）。
   */
  nim: NimClientIdentity
}

/**
 * App 档 UA 的设备段 `(<model>:Android <os>;<brand> <buildId> <tags>)`——官方
 * `HeaderInterceptor` 就是按 `Build.MODEL` / `MANUFACTURER` / `ID` / `TAGS` 拼的。
 * 只拼一次：两档共用同一台设备，机型字段全部来自 `common/android-device.ts`。
 */
const UA_DEVICE
  = `(${ANDROID_DEVICE.model}:Android ${ANDROID_DEVICE.osVersion};${ANDROID_DEVICE.brand} ${ANDROID_DEVICE.buildId} ${ANDROID_DEVICE.buildTags})`

/**
 * 口袋主 App（pocket48）Android 档：v2 登录域已启用并实测登录成功。
 *
 * 云信身份取自 pocket48 7.1.44 APK：applicationId `com.pocket.snh48.activity`，
 * 内置云信 Android SDK 9.20.12（build 92012，dex 内串 `Version: 9.20.12/92012/…`）。
 */
export const POCKET48_ANDROID: PocketClientProfile = {
  contentType: 'application/json; charset=UTF-8',
  userAgent: `PocketFans201807/7.1.44_26092001 ${UA_DEVICE}`,
  nim: { sdkVersion: 92012, packageName: 'com.pocket.snh48.activity' },
  appInfo: deviceId => ({
    IMEI: deviceId,
    appBuild: '26092001',
    appName: 'pocket48',
    appVersion: '7.1.44',
    deviceId,
    deviceName: ANDROID_DEVICE.model,
    osType: 'android',
    osVersion: ANDROID_DEVICE.osVersion,
    phoneName: ANDROID_DEVICE.model,
    phoneSystemVersion: ANDROID_DEVICE.osVersion,
    vendor: ANDROID_DEVICE.brand,
  }),
}

/**
 * 塞纳河48（seine48）Android 档：`im/api/seine/*` 有独立客户端特征（含 Device-Type 头）。
 *
 * 云信身份取自 seine48 1.3.4 APK：包名 `com.seine48.app`，内置云信 Android SDK
 * 9.21.10（build 92110）。这也是本项目长期使用的聊天室身份。
 */
export const SEINE48_ANDROID: PocketClientProfile = {
  contentType: 'application/json; charset=UTF-8',
  userAgent: `PocketFans201807/1.3.4_26092001 ${UA_DEVICE}`,
  extraHeaders: { 'X-Custom-Device-Type': 'ANDROID' },
  nim: { sdkVersion: 92110, packageName: 'com.seine48.app' },
  appInfo: deviceId => ({
    appVersion: '1.3.4',
    appBuild: 26092001,
    osType: 'android',
    appName: 'seine48',
    deviceId,
    deviceName: ANDROID_DEVICE.model,
    osVersion: ANDROID_DEVICE.osVersion,
    vendor: ANDROID_DEVICE.brand,
    IMEI: deviceId,
    phoneName: ANDROID_DEVICE.model,
    phoneSystemVersion: ANDROID_DEVICE.osVersion,
  }),
}

/**
 * 生成某档客户端的公共请求头（**不含 token 与 pa**——那两项由 pocket-auth 的
 * postPocket 统一补上，避免两处签名不一致）。`appInfo` 在此序列化，
 * 保证 `IMEI` / `deviceId` 与 UA 里的设备信息同源同值。
 */
export function clientHeaders(profile: PocketClientProfile): Record<string, string> {
  return {
    'Content-Type': profile.contentType,
    'User-Agent': profile.userAgent,
    'appInfo': JSON.stringify(profile.appInfo(pocketDeviceId())),
    'Accept-Language': 'zh-Hans-CN;q=1',
    ...(profile.extraHeaders ?? {}),
  }
}

/**
 * 档位 → 客户端特征表的唯一映射：新增档位只需在 `common/pocket-client-profile.ts` 补展示项、
 * 并在此登记对应特征。两处都要改，缺一会 typecheck 报错（Record 的键是全集的）。
 */
export const POCKET_CLIENT_PROFILES: Record<PocketClientProfileId, PocketClientProfile> = {
  pocket48: POCKET48_ANDROID,
  seine48: SEINE48_ANDROID,
}

/** 按档位取客户端特征（未知值回退默认档，与 resolvePocketClientProfile 同口径） */
export function profileFor(id: PocketClientProfileId): PocketClientProfile {
  return POCKET_CLIENT_PROFILES[id] ?? POCKET_CLIENT_PROFILES[DEFAULT_POCKET_CLIENT_PROFILE]
}

/** 按档位取云信聊天室身份（聊天室握手用；未知值回退默认档，与 profileFor 同口径） */
export function nimIdentityFor(id: PocketClientProfileId): NimClientIdentity {
  return profileFor(id).nim
}
