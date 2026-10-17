/**
 * 客户端身份档位：桌面端可模拟的官方客户端身份（**唯一来源**，主进程与渲染层共用）。
 *
 * 口袋48 与塞纳河48 是两个独立的官方 APK，共用同一套账号体系与同一批接口。服务端按
 * 客户端身份（appInfo 的 appName / UA 里的版本号 / seine 的 Device-Type 头）把同一账号的
 * 多个客户端会话分开存放，因此同一账号可以在两端**同时在线、互不挤掉**。桌面端模拟哪一个
 * 由用户在登录时选择：手机正在使用口袋48 时，桌面选塞纳河48 即可两端并存。
 *
 * 本文件只描述「身份」这一层：档位 id 与展示文案。真正的请求头取值放在
 * `main/pocket48/client-profile.ts` 按档位查表生成——那里需要设备信息与持久化装置，
 * 不能进 common（common 是同属 node / web 两份 tsconfig 的纯代码目录）。
 */

export type PocketClientProfileId = 'pocket48' | 'seine48'

export interface PocketClientProfileOption {
  id: PocketClientProfileId
  /** 展示名（登录弹窗与设置页共用，勿在两处各写一份） */
  label: string
  /** 一句话说明，给用户看「什么时候该选它」 */
  hint: string
}

export const POCKET_CLIENT_PROFILE_OPTIONS: readonly PocketClientProfileOption[] = [
  {
    id: 'pocket48',
    label: '口袋48',
    hint: '模拟口袋48官方客户端身份。手机端未在使用口袋48时选它。',
  },
  {
    id: 'seine48',
    label: '塞纳河48',
    hint: '模拟塞纳河48官方客户端身份。手机端正在使用口袋48时选它，两端可同时在线。',
  },
]

/** 缺省档位：口袋48（与历史行为一致，未登录时主进程请求也走它） */
export const DEFAULT_POCKET_CLIENT_PROFILE: PocketClientProfileId = 'pocket48'

/** 归一化外部传入的档位：无法识别（缺省、旧数据、手改值）一律回退默认档 */
export function resolvePocketClientProfile(id?: string | null): PocketClientProfileId {
  return id === 'seine48' ? 'seine48' : DEFAULT_POCKET_CLIENT_PROFILE
}

/** 按 id 取展示项；未知 id 回退默认档的展示项 */
export function pocketClientProfileOption(id: PocketClientProfileId): PocketClientProfileOption {
  return POCKET_CLIENT_PROFILE_OPTIONS.find(item => item.id === id) ?? POCKET_CLIENT_PROFILE_OPTIONS[0]
}
