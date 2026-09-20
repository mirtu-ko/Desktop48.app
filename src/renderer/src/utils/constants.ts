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
 * 分团官方 logo 的兜底图（SNH48 那张 about-logo-snh.png）。
 * 成员页分区标题在没有队伍徽章、又查不到所属团体 logo（IDFT / 燃烧吧团魂 / 新星闪耀计划 等）
 * 时统一用它，避免标题左侧出现空盒。
 */
const GROUP_LOGO_FALLBACK = 'https://www.snh48.com/images/index/about-logo-snh.png'

/**
 * 全局常量表（全部无状态）。
 *
 * 说明：这里刻意不用 `class + static` —— ES 模块本身就是单例，一个模块无论被
 * `import` 多少次都只求值一次，class 外壳不带来任何收益，反而多出 `public static`
 * 样板与 `this` 陷阱。跨组件共享的「状态」请放 `stores/`，这里只放常量。
 */
const Constants = {
  /**
   * 菜单（键命名与 Theme 保持一致：全大写下划线）。
   *
   * 值**就是路由 path**（带前导斜杠），Dock 高亮与 router.push 共用同一份值，
   * 因此不需要再单独维护一张"path ↔ 菜单键"的映射表。
   *
   * 刻意不用 `as Record<string, string>`：那会让所有字符串键都合法，
   * `Menu.LIVE`（少个 S）也能通过编译并返回 undefined 静默失效；
   * 用 `as const` 保留字面量类型，拼错的键名直接编译报错。
   */
  Menu: {
    LIVES: '/lives',
    SHOWS: '/shows',
    ALBUMS: '/albums',
    MEMBERS: '/members',
    DOWNLOADS: '/downloads',
    SETTING: '/setting',
  } as const,

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
    FOLLOW: '#ffc53d', // 关注 / 已关注：鎏金
  },

  /**
   * 分团切换 tab（公演页 / 成员页左上角浮动切换器共用）：key 即 groupId。
   * logoPng 是分团官方标识（snh48.com/images/index/about-logo-*.png，129×180 含透明通道），
   * 成员页在队伍徽章缺失时拿它当分区标题图标；tab 自身只用 label / key / color。
   * 表里没有的团体（IDFT / 燃烧吧团魂 / 新星闪耀计划 等）由 GroupLogoFallback 兜底。
   */
  GroupTabs: [
    { label: '全部', key: '0', color: '', logoPng: '' },
    { label: 'SNH48', key: '10', color: '#8FD3F6', logoPng: GROUP_LOGO_FALLBACK },
    { label: 'BEJ48', key: '11', color: '#FE2472', logoPng: 'https://www.snh48.com/images/index/about-logo-bej.png' },
    { label: 'GNZ48', key: '12', color: '#ABCA14', logoPng: 'https://www.snh48.com/images/index/about-logo-gnz.png' },
    { label: 'CKG48', key: '14', color: '#FFBA07', logoPng: 'https://www.snh48.com/images/index/about-logo-ckg.png' },
    { label: 'CGT48', key: '21', color: '#D21217', logoPng: 'https://www.snh48.com/images/index/about-logo-cgt.png' },
  ] as Array<{ label: string, key: string, color: string, logoPng: string }>,

  /** 分团 logo 的兜底地址（即 SNH48 那张）：成员页保证分区标题左侧永远有图标可用 */
  GroupLogoFallback: GROUP_LOGO_FALLBACK,
}

export default Constants
