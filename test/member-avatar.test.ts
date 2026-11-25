import type { Component } from 'vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileScript, parse } from '@vue/compiler-sfc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { nextTick } from 'vue'

/**
 * MemberAvatar 行为契约。项目无 DOM 环境：用 @vue/compiler-sfc 现场编译 SFC，
 * 再用 vue 的 createRenderer 建一个记录结构的虚拟渲染器（响应式与定时器都是真实的）。
 */
const sfcPath = fileURLToPath(new URL('../src/renderer/src/components/ui/MemberAvatar.vue', import.meta.url))

/**
 * 求值 compileScript 产物：先改写 vue import 再擦 TS 类型。
 * 顺序不能反：通用 `as X` 规则会把 `defineComponent as _defineComponent` 抹掉。
 */
function evaluate(code: string): Record<string, unknown> {
  const body = `${code
    .replace(/^import \{([^}]*)\} from ['"]vue['"];?$/gm, (_m: string, names: string) => {
      const bindings = names.split(',').map((part) => {
        const [imported, local] = part.split(/\s+as\s+/).map(item => item.trim())
        return local ? `${imported}: ${local}` : imported
      })
      return `const { ${bindings.join(', ')} } = Vue;`
    })
    .replace(/^import .*$/gm, '')
    .replace(/\(__props: any, /g, '(__props, ')
    .replace(/(\b\w+): ReturnType<typeof \w+> \| null/g, '$1')
    .replace(/(\b\w+): (any|string|number|boolean|void|unknown)\b/g, '$1')
    .replace(/\s+as [A-Za-z_$][\w$]*(<[^>]*>)?/g, '')}\nreturn { __sfc__ };`
  // eslint-disable-next-line no-new-func
  const factory = new Function('Vue', body)
  return factory(Vue) as Record<string, unknown>
}

function loadMemberAvatar(): Component {
  const source = readFileSync(sfcPath, 'utf8')
  const { descriptor, errors } = parse(source, { filename: 'MemberAvatar.vue' })
  if (errors.length)
    throw errors[0]

  // inlineTemplate：模板变量走 __props 而非 ctx，分离编译时 setup 绑定不会暴露到渲染函数
  const code = compileScript(descriptor, { id: 'member-avatar', genDefaultAs: '__sfc__', inlineTemplate: true }).content
  return evaluate(code).__sfc__ as Component
}

const MemberAvatar = loadMemberAvatar()

interface MiniNode {
  type: string
  props: Record<string, any>
  children: MiniNode[]
  parent: MiniNode | null
  /** setText / setElementText 写入的文本内容 */
  text?: string
}

/** 记录结构的虚拟渲染器：patch 逻辑照常跑，只把 DOM 操作换成对象操作 */
function createMiniRenderer() {
  return Vue.createRenderer<MiniNode, MiniNode>({
    patchProp(el, key, _prev, next) {
      if (next == null)
        delete el.props[key]
      else
        el.props[key] = next
    },
    // 按 anchor 插入（同 runtime-dom）：v-if 切分支时旧节点要先移除，靠的就是这个顺序
    insert(child, parent, anchor) {
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index >= 0)
        parent.children.splice(index, 0, child)
      else
        parent.children.push(child)
      child.parent = parent
    },
    // 按节点自身 parent 摘除（同 runtime-dom），不依赖运行时传入的 parent
    remove(child) {
      const parent = child.parent
      if (!parent)
        return
      parent.children = parent.children.filter(item => item !== child)
    },
    createElement: (type: string) => ({ type, props: {}, children: [], parent: null }),
    createText: () => ({ type: '#text', props: {}, children: [], parent: null }),
    createComment: () => ({ type: '#comment', props: {}, children: [], parent: null }),
    setText(node, text) {
      node.text = text
    },
    setElementText(node, text) {
      node.text = text
    },
    parentNode: node => node.parent,
    nextSibling: (node) => {
      const parent = node.parent
      if (!parent)
        return null
      const index = parent.children.indexOf(node)
      return parent.children[index + 1] ?? null
    },
    insertStaticContent() {
      const node: MiniNode = { type: '#static', props: {}, children: [], parent: null }
      return [node, node]
    },
  })
}

/** 调用当前 img 的 onError，等价于加载失败 */
async function triggerError(container: MiniNode): Promise<void> {
  const img = find(container, 'img')
  if (!img)
    throw new Error('当前没有 img 可失败')
  const handler = img.props.onError
  if (typeof handler === 'function')
    handler()
  else if (handler && typeof handler === 'object' && handler.value)
    (handler.value as () => void)()
  await nextTick()
}

/** 推进一帧并等渲染稳定（fake timers 下的定时器回调还要落一轮更新） */
async function flushRerender(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await nextTick()
  await nextTick()
}

const reactiveProps = { current: { src: '' } }

function mount(props: { src: string, alt?: string, retryDelay?: number }) {
  const container: MiniNode = { type: 'root', props: {}, children: [], parent: null }
  reactiveProps.current = props
  const app = createMiniRenderer().createApp({
    render: () => Vue.h(MemberAvatar, { ...reactiveProps.current }, { default: () => Vue.h('span', { class: 'avatar-fallback' }, '吕') }),
  })
  app.mount(container)
  return { app, container }
}

/** 模拟父组件换人：改 props 后重渲染 */
function setSrc(app: ReturnType<typeof mount>['app'], src: string): void {
  reactiveProps.current = { ...reactiveProps.current, src }
  const instance = (app as any)._instance
  if (instance)
    instance.update()
}

/** 深度查找第一个匹配节点 */
function find(node: MiniNode, type?: string, predicate?: (n: MiniNode) => boolean): MiniNode | undefined {
  if ((!type || node.type === type) && (!predicate || predicate(node)))
    return node
  for (const child of node.children) {
    const hit = find(child, type, predicate)
    if (hit)
      return hit
  }
  return undefined
}

/** 读组件内部状态（expose 的 failed / retryCount） */
function stateOf(app: ReturnType<typeof mount>['app']) {
  // 根实例是包装组件，目标组件实例在 subTree.component 上
  const exposed = (app as any)._instance.subTree.component.exposed
  // expose 出来的是 ref 本体，需 .value
  return {
    failed: exposed.failed.value,
    retryCount: exposed.retryCount.value,
  }
}

/** 当前 img 的 src，无 img 为 null */
function imgSrc(container: MiniNode): string | null {
  return find(container, 'img')?.props.src ?? null
}

function fallbackText(container: MiniNode): string | null {
  const span = find(container, 'span', n => n.props.class === 'avatar-fallback')
  return span ? (span.text ?? '') : null
}

const SRC = 'https://www.snh48.com/images/member/zp_30119.jpg'

describe('memberAvatar（头像失败自动重试一次）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('渲染契约：直出 img，带 no-referrer，且不带重试参数', () => {
    const { container } = mount({ src: SRC })
    const img = find(container, 'img')!
    expect(img.props.src).toBe(SRC)
    expect(img.props.referrerpolicy).toBe('no-referrer')
    expect(fallbackText(container)).toBeNull()
  })

  it('首次失败：先显示兜底占位，1.5s 后换成带 _retry=1 的新地址重挂', async () => {
    const { app, container } = mount({ src: SRC })

    await triggerError(container)
    // 等待重试期间先兜底，并已用完唯一一次重试机会
    expect(stateOf(app).failed).toBe(true)
    expect(stateOf(app).retryCount).toBe(1)

    await vi.advanceTimersByTimeAsync(1500)
    await flushRerender()

    expect(imgSrc(container)).toBe(`${SRC}?_retry=1`)
    expect(fallbackText(container)).toBeNull()
  })

  it('重试再失败：直接兜底，不再发起第三次请求', async () => {
    const { app, container } = mount({ src: SRC })
    await triggerError(container)
    await vi.advanceTimersByTimeAsync(1500)
    await flushRerender()
    expect(imgSrc(container)).toBe(`${SRC}?_retry=1`)

    await triggerError(container)
    await vi.advanceTimersByTimeAsync(10_000)
    await flushRerender()

    expect(stateOf(app).failed).toBe(true)
    expect(imgSrc(container)).toBeNull()
    expect(stateOf(app).retryCount).toBe(1)
  })

  it('换人（src 变化）时复位：失败态、重试计数与访问都归零', async () => {
    const { app, container } = mount({ src: SRC })
    await triggerError(container)
    expect(stateOf(app).failed).toBe(true)

    const next = 'https://www.snh48.com/images/member/zp_10013.jpg'
    setSrc(app, next)
    await flushRerender()

    expect(imgSrc(container)).toBe(next)
    expect(stateOf(app).failed).toBe(false)
    expect(stateOf(app).retryCount).toBe(0)
  })

  it('地址已带查询串时用 & 拼重试参数', async () => {
    const { container } = mount({ src: `${SRC}?ram=1` })
    await triggerError(container)
    await vi.advanceTimersByTimeAsync(1500)
    await flushRerender()
    expect(imgSrc(container)).toBe(`${SRC}?ram=1&_retry=1`)
  })
})
