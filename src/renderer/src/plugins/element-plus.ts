/**
 * Element Plus 按需注册（渲染层唯一样式入口）。
 *
 * 模板里出现新的 <el-x> 必须在这里同步加一行组件与一行 style，漏了由
 * test/element-plus-components.test.ts 拦下（运行时只会是空标签 + console 警告）。
 * 只注册组件不引 style 会渲染成裸标签；只引 style 不注册则样式空转，两者成对出现。
 */
import type { App } from 'vue'

import { ElButton, ElCarousel, ElCarouselItem, ElCascader, ElDialog, ElEmpty, ElIcon, ElImage, ElInput, ElOption, ElProgress, ElRadio, ElRadioButton, ElRadioGroup, ElScrollbar, ElSelect, ElTabPane, ElTabs, ElTag, ElText, ElTooltip } from 'element-plus'

import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/carousel/style/css'
import 'element-plus/es/components/carousel-item/style/css'
import 'element-plus/es/components/cascader/style/css'
import 'element-plus/es/components/dialog/style/css'
import 'element-plus/es/components/empty/style/css'
import 'element-plus/es/components/icon/style/css'
import 'element-plus/es/components/image/style/css'
import 'element-plus/es/components/input/style/css'
import 'element-plus/es/components/option/style/css'
import 'element-plus/es/components/progress/style/css'
import 'element-plus/es/components/radio/style/css'
import 'element-plus/es/components/radio-button/style/css'
import 'element-plus/es/components/radio-group/style/css'
import 'element-plus/es/components/scrollbar/style/css'
import 'element-plus/es/components/select/style/css'
import 'element-plus/es/components/tab-pane/style/css'
import 'element-plus/es/components/tabs/style/css'
import 'element-plus/es/components/tag/style/css'
import 'element-plus/es/components/text/style/css'
import 'element-plus/es/components/tooltip/style/css'

// ElMessage / ElMessageBox 是函数 API，不进模板也不进下面的清单。
// 样式必须在这里集中引一次：调用点分散在 store 与 composable（tasks、member-flags、
// use-download-guard 等），样式若跟着某个懒加载页面走，后台弹提示会出现无样式的一帧。
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'

/**
 * 已注册组件，键名即组件名。
 * 用对象而非数组：测试靠 Object.keys 与模板里的 <el-x> 做双向差集，键名是唯一事实来源。
 */
export const ELEMENT_COMPONENTS = {
  ElButton,
  ElCarousel,
  ElCarouselItem,
  ElCascader,
  ElDialog,
  ElEmpty,
  ElIcon,
  ElImage,
  ElInput,
  ElOption,
  ElProgress,
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
  ElScrollbar,
  ElSelect,
  ElTabPane,
  ElTabs,
  ElTag,
  ElText,
  ElTooltip,
}

/** 主窗口与独立播放窗共用：两个 createApp 的挂载点都要调一次 */
export function installElement(app: App): void {
  Object.values(ELEMENT_COMPONENTS).forEach(component => app.use(component))
}
