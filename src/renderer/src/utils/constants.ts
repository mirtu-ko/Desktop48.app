/**
 * 成员状态（starInfo.status 字段取值，接口约定）：成员页分区、详情抽屉标签、回放页排序共用。
 * 附展示元信息（标签文案 + 语义色），三处此前各自硬编码 1/2/3，收口于此
 */
const MemberStatus = {
  Active: 1,
  Hiatus: 2,
  Left: 3,
} as const

const MemberStatusMeta: Record<number, { label: string, tag: 'success' | 'warning' | 'info' }> = {
  [MemberStatus.Active]: { label: '在团', tag: 'success' },
  [MemberStatus.Hiatus]: { label: '暂休', tag: 'warning' },
  [MemberStatus.Left]: { label: '退团', tag: 'info' },
}

/**
 * 全局常量表（全部无状态）。
 *
 * 说明：这里刻意不用 `class + static` —— ES 模块本身就是单例，一个模块无论被
 * `import` 多少次都只求值一次，class 外壳不带来任何收益，反而多出 `public static`
 * 样板与 `this` 陷阱。跨组件共享的「状态」请放 `stores/`，这里只放常量。
 */
const Constants = {
  /** 默认User-Agent */
  DEFAULT_USER_AGENT: 'Mozilla/5.0 (Linux; U; Android 8.1.0;) AppleWebKit/537.36 (KHTML, like Gecko)',

  /** 菜单（键命名与 Theme 保持一致：全大写下划线；值为路由 path） */
  Menu: {
    LIVES: 'lives',
    SHOWS: 'shows',
    ALBUMS: 'albums',
    MEMBERS: 'members',
    DOWNLOADS: 'downloads',
    SETTING: 'setting',
  } as Record<string, string>,

  MemberStatus,
  MemberStatusMeta,

  /**
   * 语义主题色：页面/功能主题色的唯一来源（Dock 菜单、任务分组、设置行、
   * app.scss 的 --color-* 变量均与此保持一致），改色只需改这里
   */
  Theme: {
    LIVES: '#ff5e7e', // 直播 / 录制：玫红
    SHOWS: '#f59e0b', // 公演：琥珀
    ALBUMS: '#d946ef', // 专辑：品红
    MEMBERS: '#3b82f6', // 成员：蓝
    DOWNLOADS: '#10b981', // 下载：绿
    SETTING: '#6d5ae0', // 设置：品牌紫
  },

  /** 分团切换 tab（公演页 / 成员页左上角浮动切换器共用）：key 即 groupId */
  GroupTabs: [
    { label: '全部', key: '0', color: '' },
    { label: 'SNH48', key: '10', color: '#8FD3F6' },
    { label: 'BEJ48', key: '11', color: '#FE2472' },
    { label: 'GNZ48', key: '12', color: '#ABCA14' },
    { label: 'CKG48', key: '14', color: '#FFBA07' },
    { label: 'CGT48', key: '21', color: '#D21217' },
  ] as Array<{ label: string, key: string, color: string }>,
}

export default Constants
