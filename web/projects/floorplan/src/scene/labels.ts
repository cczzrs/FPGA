import type * as THREE from 'three'

export type Align = 'center' | 'start' | 'end' | 'above' | 'below'

export interface Label {
  element: HTMLElement
  position: THREE.Vector3
  align: Align
  /** 0 表示不显示。 */
  priority: number
  key: string
  width: number
  height: number
  shown: boolean
}

interface Placed { x0: number; y0: number; x1: number; y1: number }

const GAP = 3
const INSET = 2
/** 标签最多离锚点这么远；再远就会让人认错对象，宁可隐藏。 */
const MAX_NUDGE = 32

/** 按优先级放置标签：放不下的隐藏，绝不互相覆盖。 */
export class Labels {
  private host: HTMLElement
  private open: (id: string) => void
  private list: Label[] = []
  private width = 1
  private height = 1

  constructor(host: HTMLElement, open: (id: string) => void) {
    this.host = host
    this.open = open
    // 标签是画布内容的视觉副本；键盘和读屏走层级树、端口表。
    host.setAttribute('aria-hidden', 'true')
  }

  add(position: THREE.Vector3, align: Align, className: string, open?: string): Label {
    const element = document.createElement(open ? 'button' : 'span')
    element.className = `label ${className}`
    if (open) {
      element.tabIndex = -1
      // 标签不取得焦点，否则焦点会落进对读屏隐藏的区域。
      element.addEventListener('mousedown', (event) => event.preventDefault())
      element.addEventListener('click', () => this.open(open))
    }
    this.host.append(element)
    const label: Label = { element, position, align, priority: 0, key: '', width: 0, height: 0, shown: false }
    this.list.push(label)
    return label
  }

  text(label: Label, name: string, value = '', active = false, state?: unknown): void {
    const key = `${name}|${value}|${active}|${state}`
    if (key === label.key) return
    label.key = key
    label.width = 0
    const nodes: (Node | string)[] = name ? [name] : []
    if (value) {
      const badge = document.createElement('b')
      badge.textContent = value
      nodes.push(badge)
    }
    label.element.replaceChildren(...nodes)
    label.element.dataset.active = String(active)
    label.element.dataset.value = state === undefined ? '' : String(state)
  }

  clear(): void {
    this.host.replaceChildren()
    this.list = []
  }

  resize(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  remeasure(): void {
    for (const label of this.list) label.width = 0
  }

  place(camera: THREE.Camera): void {
    const candidates = this.list.filter((l) => l.priority > 0)
    // 先统一读尺寸，再统一写位置，避免反复触发回流。
    for (const label of candidates) {
      if (label.width) continue
      label.width = label.element.offsetWidth
      label.height = label.element.offsetHeight
    }
    const origin = this.host.getBoundingClientRect()
    const placed: Placed[] = []
    for (const hud of this.host.parentElement!.querySelectorAll<HTMLElement>('.hud')) {
      if (!hud.offsetWidth) continue
      const r = hud.getBoundingClientRect()
      placed.push({ x0: r.left - origin.left, y0: r.top - origin.top, x1: r.right - origin.left, y1: r.bottom - origin.top })
    }

    const spots = new Map<Label, Placed>()
    for (const label of candidates.sort((a, b) => b.priority - a.priority)) {
      const spot = this.findSpot(label, camera, placed)
      if (!spot) continue
      placed.push(spot)
      spots.set(label, spot)
    }
    for (const label of this.list) {
      const spot = spots.get(label)
      if (label.shown !== !!spot) {
        label.shown = !!spot
        label.element.classList.toggle('shown', label.shown)
      }
      if (spot) label.element.style.transform = `translate(${Math.round(spot.x0)}px, ${Math.round(spot.y0)}px)`
    }
  }

  private findSpot(label: Label, camera: THREE.Camera, placed: Placed[]): Placed | null {
    const { width: w, height: h, align, priority } = label
    const p = label.position.clone().project(camera)
    if (p.z > 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05) return null
    const x = ((p.x + 1) / 2) * this.width
    const y = ((1 - p.y) / 2) * this.height
    let left = x - w / 2
    let top = y - h / 2
    if (align === 'start') left = x + GAP
    if (align === 'end') left = x - w - GAP
    if (align === 'above') top = y - h - GAP
    if (align === 'below') top = y + GAP

    const offsets: [number, number][] = [[0, 0]]
    if (priority >= 55) {
      if (align === 'start' || align === 'end') offsets.push([0, -h * 0.4], [0, h * 0.4])
      else if (align === 'center') offsets.push([0, -h * 0.7], [0, h * 0.7])
      else offsets.push([0, align === 'above' ? -h : h], [-w / 2, 0], [w / 2, 0])
    }
    for (const [dx, dy] of offsets) {
      let x0 = left + dx
      let y0 = top + dy
      if (priority >= 55) {
        // 重要标签贴着画布边缘收进来。
        x0 = Math.min(Math.max(x0, INSET), this.width - w - INSET)
        y0 = Math.min(Math.max(y0, INSET), this.height - h - INSET)
        if (priority < 120) {
          // 左右引出的端口标签可以沿自己的引线内收，但不能换行。
          const alongLead = priority >= 88 && (align === 'start' || align === 'end')
          if (Math.abs(x0 - left - dx) > (alongLead ? w + GAP : MAX_NUDGE) || Math.abs(y0 - top - dy) > MAX_NUDGE) continue
        }
      } else if (x0 < 0 || y0 < 0 || x0 + w > this.width || y0 + h > this.height) continue
      const spot = { x0, y0, x1: x0 + w, y1: y0 + h }
      if (placed.every((o) => spot.x1 + 1 < o.x0 || o.x1 + 1 < spot.x0 || spot.y1 + 1 < o.y0 || o.y1 + 1 < spot.y0)) return spot
    }
    return null
  }
}
