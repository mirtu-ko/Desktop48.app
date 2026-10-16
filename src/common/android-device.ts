/**
 * 伪装的 Android 设备（机型事实的**唯一来源**，主进程与渲染层共用）。
 *
 * 两套身份链共用同一台设备，只是呈现形态不同：
 * - App 档（`main/pocket48/client-profile.ts`）
 *   `PocketFans201807/<版本>_<build> (<model>:Android <os>;<brand> <buildId> <tags>)`
 * - 站点档（`renderer/src/services/request.ts`）
 *   移动端浏览器 UA `... (Linux; Android <os>; <model>) ...`
 *
 * 两处若各写各的机型，同一出口 IP 在服务端看就是两台设备（App 来自 A、浏览器来自 B），
 * 叙事上不成立；因此机型字段只在此处定义，改机型只改这里。
 *
 * 机型取红米 K 系列（国内保有量大的中端机），而非参考实现 yaya_msg 那台 Samsung S10——
 * 后者是国内极低频的三星机型。`brand` / `model` / `osVersion` 是设备事实，
 * `buildId` / `buildTags` 是 UA 里的系统构建描述，取该机型 Android 14 / HyperOS 的实际形态。
 *
 * ⚠️ 改这里的值等于**换伪装身份**：已验证过的 A/B（脚本 D:/DEV/48/probe-profile.mjs）覆盖的是
 * 平台维度（同 token 同 pa，iOS 档 ↔ Android 档），机型维度未单独验过，如要严格复核需重跑该脚本。
 */
export const ANDROID_DEVICE = {
  /** `Build.MANUFACTURER`（UA 里的 manufacturer 段） */
  brand: 'Xiaomi',
  /** `Build.MODEL`（机型码），同时是 appInfo 的 `deviceName` / `phoneName` */
  model: '23013RK75C',
  /** `Build.VERSION.RELEASE`，同时是 appInfo 的 `osVersion` / `phoneSystemVersion` */
  osVersion: '14',
  /** `Build.ID` */
  buildId: 'UKQ1.231003.002',
  /** `Build.TAGS` */
  buildTags: 'release-keys',
} as const
