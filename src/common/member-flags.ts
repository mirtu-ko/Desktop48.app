/** 屏蔽与关注都是「按成员维护的布尔标记」，共用同一套读写与 IPC 语义。 */
export type MemberFlagKind = 'blocked' | 'followed'

/** 主进程返回给渲染层的名单条目。 */
export interface MemberFlag {
  userId: number
  realName: string
  teamColor: string
  [key: string]: unknown
}

/** 渲染层发起增删时的最小入参；userId 兼容历史字符串形式。 */
export interface MemberFlagTarget {
  userId: number | string
  realName: string
  teamColor?: string
  [key: string]: unknown
}

/** IPC 入参来自渲染层，必须在主进程再次校验，不能只依赖 TypeScript。 */
export function assertMemberFlagKind(value: unknown): asserts value is MemberFlagKind {
  if (value !== 'blocked' && value !== 'followed')
    throw new Error(`Invalid member flag kind: ${String(value)}`)
}
