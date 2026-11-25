import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Design, Module } from '../model/cells.ts'
import { display, displayPort, selection, type Result, type Shown } from '../model/sim.ts'
import { activeStages, isUsed } from './activity.ts'
import { Labels, type Align, type Label } from './labels.ts'
import { layout, WIRE_Z, type Box, type Pin, type Scene, type Shape, type Tone, type Wire } from './layout.ts'
import { paths } from './paths.ts'
import type { Point, Rect, Side } from './route.ts'
import { createShapes } from './shapes.ts'

export const VALUE_COLOR = { 1: '#ffb020', 0: '#38a8ff', pending: '#5d6878', unused: '#334258' } as const
/** path：线色区分路径，明暗表示 1/0；value：线色直接表示值。 */
export type WireMode = 'path' | 'value'

const BACKGROUND = new THREE.Color('#0b1119')
const WHITE = new THREE.Color('#ffffff')
/** 总览里的逻辑块只有十几像素，点在这个半径内就算点中它。 */
const BLOCK_REACH = 16
const ACTIVE = '#7dffd6'
const TONE: Record<Tone, string> = {
  chip: '#33445c', block: '#2fb9a6', slice: '#28577a', lut: '#5361c2', carry4: '#9a6a2c', carrybit: '#9a6a2c',
  ccu: '#9a6a2c', ff: '#2f8a5b', latch: '#2f8a5b', mux: '#68758b', xor: '#8a5aa8', adder: '#785577',
  select: '#566378', switch: '#d9e2ee', pad: '#b54c8e', cfg: '#44536a', and: '#3f7fa6', or: '#8a5aa8', not: '#8b9a4f',
  logic: '#294d68', io: '#7d3d69', bram: '#3f8a55', dsp: '#b07a2e', metal: '#8d7650', metalTop: '#b39a68',
  die: '#18232f', substrate: '#1f4a3a', package: '#3a3f47', ball: '#9aa3ad',
}
const TILE_INFO: Partial<Record<Tone, string>> = {
  io: 'I/O：芯片与外部引脚之间的接口。总览只示意它的位置。',
  bram: '块 RAM：独立的大容量存储块。本演示不展开，也未使用它。',
  dsp: 'DSP：硬件乘法与累加单元。本演示不展开，也未使用它。',
}
const VALUE_TEXT: Record<string, string> = { '0': '0', '1': '1', pending: '·', unused: '' }
const INWARD: Record<Side, Align> = { l: 'start', r: 'end', t: 'below', b: 'above' }
const OUTWARD: Record<Side, Align> = { l: 'end', r: 'start', t: 'above', b: 'below' }

const world = (x: number, y: number, z = 0) => new THREE.Vector3(x, z, -y)
const centerOf = (r: Rect): Point => [r.x + r.w / 2, r.y + r.h / 2]

interface BoxInstance { box: Box; mesh: THREE.InstancedMesh; index: number }
interface Segment { wire: Wire; a: Point; b: Point; index: number }
type Labelled =
  | { label: Label; type: 'box'; box: Box }
  | { label: Label; type: 'pin'; pin: Pin }
  | { label: Label; type: 'wire'; wire: Wire }
  | { label: Label; type: 'bus'; name: string; pads: Module[] }
  | { label: Label; type: 'note'; text: string }

export interface ViewEvents {
  open(id: string): void
  info(text: string): void
}

export class View {
  renders = 0
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(28, 1, 0.5, 3000)
  private controls: OrbitControls
  private labels: Labels
  private events: ViewEvents
  private host: HTMLElement
  private motion: MediaQueryList

  private shapes = createShapes()
  private solid = new THREE.MeshLambertMaterial()
  private translucent = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false })
  private flat = new THREE.MeshBasicMaterial()
  private sphere = new THREE.SphereGeometry(1, 10, 8)
  private segmentBox = new THREE.BoxGeometry(1, 1, 1)
  private pulseMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' })

  private content = new THREE.Group()
  private layout: Scene | null = null
  private boxes: BoxInstance[] = []
  private boxMeshes: THREE.InstancedMesh[] = []
  private segments: Segment[] = []
  private wireMesh: THREE.InstancedMesh | null = null
  private pinMesh: THREE.InstancedMesh | null = null
  private dotMesh: THREE.InstancedMesh | null = null
  private pulseMesh: THREE.InstancedMesh | null = null
  private highlight: THREE.LineSegments | null = null
  private labelled: Labelled[] = []
  private moving: Wire[] = []

  private result: Result | null = null
  private mode: WireMode = 'path'
  /** 线路说明里选中的路径；其余线压暗。 */
  private spot: string | null = null
  private playing = false
  private progress = 0
  private frame = 0
  private touched = false
  /** 窄画布只标当前模块、用到的端口和活动连线。 */
  private compact = false
  private tween: { start: number; from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3] } | null = null

  constructor(host: HTMLElement, overlay: HTMLElement, events: ViewEvents) {
    this.host = host
    this.events = events
    this.motion = matchMedia('(prefers-reduced-motion: reduce)')
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    const canvas = this.renderer.domElement
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', 'FPGA 三维结构图。层级树与端口表提供相同的内容和操作。')
    host.prepend(canvas)

    this.scene.background = BACKGROUND
    const sun = new THREE.DirectionalLight('#ffffff', 1.7)
    sun.position.set(-40, 120, 55)
    this.scene.add(new THREE.HemisphereLight('#e8f1ff', '#26303c', 1.9), sun, this.content)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.maxPolarAngle = 1.45
    this.controls.zoomToCursor = true
    this.controls.addEventListener('change', () => this.invalidate())
    this.controls.addEventListener('start', () => {
      this.tween = null
      this.touched = true
    })

    this.labels = new Labels(overlay, (id) => events.open(id))
    this.bindPointer(canvas)
    this.bindContextLoss(canvas)
    new ResizeObserver(() => this.resize()).observe(host)
    document.fonts.ready.then(() => {
      this.labels.remeasure()
      this.invalidate()
    })
    this.resize()
  }

  /** 状态变化时调用；只有换了观察模块才重建几何。 */
  update(result: Result, focus: Module, playing: boolean, progress: number): void {
    const first = !this.layout
    const rebuilt = this.layout?.focus !== focus
    this.result = result
    this.playing = playing
    this.progress = progress
    if (rebuilt) {
      this.build(layout(result.design, focus))
      this.touched = false
      this.fit(!first)
    }
    this.paint()
    this.invalidate()
  }

  animate(progress: number): void {
    this.progress = progress
    if (this.motion.matches || !this.result) return
    if (this.layout?.focus.kind === 'lut') this.paint()
    else if (!this.moving.length) return
    this.invalidate()
  }

  setMode(mode: WireMode): void {
    this.mode = mode
    this.paint()
    this.invalidate()
  }

  spotlight(key: string | null): void {
    if (key === this.spot) return
    this.spot = key
    this.paint()
    this.invalidate()
  }

  reset(): void {
    this.touched = false
    this.fit(true)
  }

  invalidate(): void {
    if (!this.frame) this.frame = requestAnimationFrame((now) => this.render(now))
  }

  // ---------- 建几何 ----------

  private clear(): void {
    this.content.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) object.dispose()
      if (object instanceof THREE.LineSegments) {
        object.geometry.dispose()
        ;(object.material as THREE.Material).dispose()
      }
    })
    this.content.clear()
    this.labels.clear()
    this.boxes = []
    this.boxMeshes = []
    this.segments = []
    this.labelled = []
    this.moving = []
    this.wireMesh = this.pinMesh = this.dotMesh = this.pulseMesh = this.highlight = null
  }

  private build(scene: Scene): void {
    this.clear()
    this.layout = scene
    this.buildBoxes(scene)
    this.buildWires(scene)
    this.buildOutlines(scene)
    this.buildLabels(scene)
  }

  private instanced(geometry: THREE.BufferGeometry, material: THREE.Material, count: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, count)
    for (let i = 0; i < count; i++) mesh.setColorAt(i, WHITE)
    this.content.add(mesh)
    return mesh
  }

  private buildBoxes(scene: Scene): void {
    const groups = new Map<string, Box[]>()
    for (const box of scene.boxes) {
      const key = box.group ? 'group' : box.shape
      groups.set(key, [...(groups.get(key) ?? []), box])
    }
    const matrix = new THREE.Matrix4()
    for (const [key, list] of groups) {
      const group = key === 'group'
      const mesh = this.instanced(this.shapes[group ? 'box' : (key as Shape)], group ? this.translucent : this.solid, list.length)
      mesh.userData.boxes = list
      list.forEach((box, index) => {
        const [cx, cy] = centerOf(box.rect)
        matrix.compose(world(cx, cy, box.z), new THREE.Quaternion(), new THREE.Vector3(box.rect.w, box.height, box.rect.h))
        mesh.setMatrixAt(index, matrix)
        this.boxes.push({ box, mesh, index })
      })
      this.boxMeshes.push(mesh)
    }
  }

  private buildWires(scene: Scene): void {
    for (const wire of scene.wires) {
      for (let i = 1; i < wire.points.length; i++) {
        this.segments.push({ wire, a: wire.points[i - 1]!, b: wire.points[i]!, index: this.segments.length })
      }
    }
    if (this.segments.length) this.wireMesh = this.instanced(this.segmentBox, this.flat, this.segments.length)
    if (scene.pins.length) {
      this.pinMesh = this.instanced(this.sphere, this.flat, scene.pins.length)
      const size = this.wireWidth() * 1.25
      scene.pins.forEach((pin, i) => {
        const z = scene.focus.kind === 'chip' ? 2.3 : WIRE_Z
        this.pinMesh!.setMatrixAt(i, new THREE.Matrix4().makeScale(size, size, size).setPosition(world(...pin.at, z)))
      })
    }
    if (scene.junctions.length) {
      this.dotMesh = this.instanced(this.sphere, this.flat, scene.junctions.length)
      scene.junctions.forEach((j, i) => {
        this.dotMesh!.setMatrixAt(i, new THREE.Matrix4().makeScale(0.5, 0.5, 0.5).setPosition(world(...j.at, j.z)))
      })
    }
    if (scene.wires.length) {
      this.pulseMesh = new THREE.InstancedMesh(this.sphere, this.pulseMaterial, scene.wires.length)
      this.pulseMesh.count = 0
      this.pulseMesh.frustumCulled = false
      this.content.add(this.pulseMesh)
    }
  }

  private buildOutlines(scene: Scene): void {
    const { focus, frame } = scene
    if (focus.kind !== 'chip') this.outline([{ rect: frame, z: 0 }], '#6f89a8')
    scene.rings.forEach((ring, i) => this.outline([{ rect: ring.rect, z: -0.4 * (i + 1) }], i ? '#243244' : '#3a4d66'))
    this.highlight = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: ACTIVE, depthTest: false }))
    this.highlight.renderOrder = 2
    this.highlight.frustumCulled = false
    this.content.add(this.highlight)
  }

  private outline(items: { rect: Rect; z: number }[], color: string): void {
    const geometry = new THREE.BufferGeometry().setFromPoints(rectEdges(items))
    this.content.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color })))
  }

  private buildLabels(scene: Scene): void {
    const { focus } = scene
    const add = (position: THREE.Vector3, align: Align, className: string, open?: string) =>
      this.labels.add(position, align, className, open)

    for (const note of scene.notes) {
      const label = add(world(...note.at, note.z), 'center', 'zone')
      label.priority = 148
      this.labelled.push({ label, type: 'note', text: note.text })
    }
    scene.rings.forEach((ring, i) => {
      const { x, y, h } = ring.rect
      const label = add(world(x, y + h, -0.4), 'start', 'ring', ring.module.id)
      label.priority = 74 - i * 30
      this.labels.text(label, ring.module.name)
    })
    for (const box of scene.boxes) {
      const { module, rect } = box
      if (!module || box.preview) continue
      if (module.kind === 'cfg' && focus.kind === 'lut') {
        const label = add(world(rect.x, rect.y + rect.h / 2, box.height), 'end', 'cfg-bit')
        this.labelled.push({ label, type: 'box', box })
        continue
      }
      const [cx, cy] = centerOf(rect)
      if (module.kind === 'pad') {
        // 引脚标签朝芯片外侧引出，一行一个。
        const input = module.ports[0]!.dir === 'out'
        const label = add(world(input ? rect.x : rect.x + rect.w, cy, box.height), input ? 'end' : 'start', 'title pad')
        this.labelled.push({ label, type: 'box', box })
        continue
      }
      const position = box.group ? world(cx, rect.y + rect.h, 0.2) : world(cx, cy, box.z + box.height)
      const align: Align = box.group || module.kind === 'switch' ? 'above'
        : focus.kind === 'chip' && module.kind === 'block' ? (module.aux ? 'above' : 'below')
        : 'center'
      // 开关标签只作注释：它紧贴逻辑块，不能挡住对逻辑块的点击。
      const open = module.kind === 'switch' ? undefined : box.open
      this.labelled.push({ label: add(position, align, 'title', open), type: 'box', box })
    }
    if (focus.kind === 'chip') this.buildBusLabels(scene)
    for (const pin of scene.pins) {
      // I/O 的值已经写在引脚标题里。
      if (pin.module.kind === 'pad' || pin.module.kind === 'cfg') continue
      const z = pin.boundary ? WIRE_Z : 3
      const align = (pin.boundary ? OUTWARD : INWARD)[pin.side]
      this.labelled.push({ label: add(world(...pin.at, z), align, pin.boundary ? 'port boundary' : 'port'), type: 'pin', pin })
    }
    if (focus.kind === 'lut') return
    const named = new Set<string | number>()
    const { design } = this.result!
    for (const wire of scene.wires) {
      if (wire.idle) continue
      // 一条反馈由三段线组成，只标一次。
      if (focus.kind === 'chip' && !(wire.feedback && wire.from && wire.to)) continue
      const key = wire.feedback ? feedbackName(design, wire.net) : wire.net
      if (named.has(key)) continue
      named.add(key)
      let best: [Point, Point] = [wire.points[0]!, wire.points[1]!]
      for (let i = 1; i < wire.points.length; i++) {
        if (length(wire.points[i - 1]!, wire.points[i]!) > length(...best)) best = [wire.points[i - 1]!, wire.points[i]!]
      }
      const [[ax, ay], [bx, by]] = best
      this.labelled.push({ label: add(world((ax + bx) / 2, (ay + by) / 2, wire.z), 'center', 'wire'), type: 'wire', wire })
    }
  }

  /** 窄画布把引脚合成“A 0111”或“CLK=1 EN=1 CLR=0”，避免相邻引脚互相挤掉。 */
  private buildBusLabels(scene: Scene): void {
    const groups = new Map<string, Box[]>()
    for (const box of scene.boxes) {
      if (box.module?.kind !== 'pad') continue
      const bus = /^([A-Z])\d$/.exec(box.module.name)?.[1]
      const key = bus ?? `#${box.module.ports[0]!.dir}`
      groups.set(key, [...(groups.get(key) ?? []), box])
    }
    for (const [key, boxes] of groups) {
      const name = key.startsWith('#') ? '' : key
      const ys = boxes.map((box) => centerOf(box.rect)[1])
      const position = world(centerOf(boxes[0]!.rect)[0], (Math.min(...ys) + Math.max(...ys)) / 2, 2)
      // 落单的 Cout 紧贴 S 总线下方，向下引出。
      const align: Align = !name && boxes.length === 1 && groups.size > 2 ? 'below' : 'center'
      const label = this.labels.add(position, align, 'title')
      this.labelled.push({ label, type: 'bus', name, pads: boxes.map((box) => box.module!) })
    }
  }

  // ---------- 上色：所有值只经 display() ----------

  private wireWidth(): number {
    const kind = this.layout?.focus.kind
    return kind === 'chip' ? 0.17 : kind === 'lut' ? 0.2 : 0.3
  }

  private paint(): void {
    const { layout: scene, result } = this
    if (!scene || !result) return
    const { design, stage } = result
    const { focus } = scene
    const lut = focus.kind === 'lut'
    const selected = lut ? selection(result, focus) : null
    // 在“MUX 分支”阶段逐级点亮选中的路径。
    const levels = Math.log2(focus.children.filter((c) => c.kind === 'cfg').length)
    const growing = lut && this.playing && stage === focus.at && !this.motion.matches
    const reach = lut && stage < focus.at ? 0 : growing ? Math.floor(this.progress * (levels + 2)) : Infinity
    const onPath = (module?: Module) =>
      !module || (!!selected?.path.has(module) && (module.kind === 'cfg' || Number(/^m(\d)/.exec(module.key)?.[1]) < reach))

    const color = new THREE.Color()
    const lit: { rect: Rect; z: number }[] = []
    for (const { box, mesh, index } of this.boxes) {
      const { module } = box
      color.set(TONE[box.tone])
      if (module) {
        if (module.kind === 'cfg') {
          color.set(VALUE_COLOR[module.value!])
          const chosen = lut ? onPath(module) : isUsed(module)
          if (!chosen) color.lerp(BACKGROUND, 0.66)
          else if (lut) lit.push({ rect: box.rect, z: box.height })
        } else if (lut) {
          if (onPath(module)) color.lerp(WHITE, 0.45)
          else color.lerp(BACKGROUND, 0.6)
        } else {
          const active = activeStages(design, module).has(stage)
          if (!isUsed(module) && module.kind !== 'block') color.lerp(BACKGROUND, 0.62)
          else if (active) color.lerp(WHITE, box.preview ? 0.35 : 0.2)
          else if (module.aux) color.lerp(BACKGROUND, 0.35)
          // 总览里的示例逻辑块很小，始终描边。
          if ((active || (focus.kind === 'chip' && module.kind === 'block')) && !box.preview) lit.push({ rect: box.rect, z: box.z + box.height + 0.05 })
        }
      }
      mesh.setColorAt(index, color)
    }
    for (const mesh of this.boxMeshes) mesh.instanceColor!.needsUpdate = true
    if (this.highlight) {
      this.highlight.geometry.dispose()
      this.highlight.geometry = new THREE.BufferGeometry().setFromPoints(rectEdges(lit))
    }

    this.moving = []
    if (this.wireMesh) {
      const base = this.wireWidth()
      const matrix = new THREE.Matrix4()
      const rotation = new THREE.Quaternion()
      const up = new THREE.Vector3(0, 1, 0)
      const routes = paths(design, scene).byNet
      for (const { wire, a, b, index } of this.segments) {
        const value = wire.idle ? 'unused' : display(result, wire.net)
        const known = typeof value === 'number'
        const chosen = !lut || !wire.from || (onPath(wire.from) && onPath(wire.to))
        const active = known && chosen && design.nets[wire.net]!.at === stage
        const path = routes.get(wire.net)
        // LUT 内部的选择树始终按值着色：64 根配置线各取一色只会更乱。
        if (this.mode === 'path' && path && value !== 'unused') {
          color.set(path.color)
          if (value === 0) color.lerp(BACKGROUND, 0.5)
          else if (value === 'pending') color.lerp(BACKGROUND, 0.72)
        } else color.set(VALUE_COLOR[value])
        if (!chosen) color.lerp(BACKGROUND, 0.78)
        const spotted = !!this.spot && path?.key === this.spot
        if (this.spot && !spotted) color.lerp(BACKGROUND, 0.75)
        this.wireMesh.setColorAt(index, color)
        const strong = active || spotted || (lut && wire.from && chosen && known)
        const width = base * (this.compact ? 1.4 : 1) * (strong ? 1.7 : value === 'unused' || !chosen ? 0.5 : 1)
        rotation.setFromAxisAngle(up, Math.atan2(b[1] - a[1], b[0] - a[0]))
        matrix.compose(world((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, wire.z + (strong ? 0.06 : 0)), rotation,
          new THREE.Vector3(length(a, b) + width, width, width))
        this.wireMesh.setMatrixAt(index, matrix)
        if (active && this.moving.at(-1) !== wire) this.moving.push(wire)
      }
      this.wireMesh.instanceMatrix.needsUpdate = true
      this.wireMesh.instanceColor!.needsUpdate = true
      // 线宽会变，包围球须随之更新。
      this.wireMesh.computeBoundingSphere()
    }
    const tint = (mesh: THREE.InstancedMesh | null, values: () => Shown[]) => {
      if (!mesh) return
      values().forEach((value, i) => mesh.setColorAt(i, color.set(VALUE_COLOR[value])))
      mesh.instanceColor!.needsUpdate = true
    }
    tint(this.pinMesh, () => scene.pins.map((pin) => displayPort(result, pin)))
    tint(this.dotMesh, () => scene.junctions.map((j) =>
      scene.wires.some((w) => w.net === j.net && !w.idle) ? display(result, j.net) : 'unused'))
    this.paintLabels(result, focus, selected)
  }

  private paintLabels(result: Result, focus: Module, selected: ReturnType<typeof selection>): void {
    const { design, stage } = result
    const { compact } = this
    // 窄屏只在当前模块有活动内容时才省掉未使用部分的标签。
    const unusedOnly = compact && focus.kind !== 'chip' && !isUsed(focus)
    for (const entry of this.labelled) {
      const { label } = entry
      if (entry.type === 'note') {
        this.labels.text(label, compact ? shortTitle(entry.text) : entry.text)
      } else if (entry.type === 'bus') {
        label.priority = compact ? 152 : 0
        const read = (pad: Module) => VALUE_TEXT[display(result, pad.ports[0]!.net)]
        const active = entry.pads.some((pad) => activeStages(design, pad).has(stage))
        if (entry.name) {
          const word = [...entry.pads].sort((a, b) => b.name.localeCompare(a.name)).map(read).join('')
          this.labels.text(label, entry.name, word, active)
        } else this.labels.text(label, entry.pads.map((pad) => `${pad.name}=${read(pad)}`).join(' '), '', active)
      } else if (entry.type === 'box') {
        const module = entry.box.module!
        if (focus.kind === 'lut') {
          const chosen = !!selected?.path.has(module) && (module.kind === 'cfg' || stage >= focus.at)
          if (module.kind === 'cfg') {
            label.priority = chosen ? 135 : !compact && focus.children.length < 40 ? 45 : 0
            this.labels.text(label, module.name, String(module.value), chosen, module.value)
          } else {
            const select = module.ports.find((p) => p.name === 'S')!
            label.priority = chosen ? 78 : 0
            const value = display(result, select.net)
            this.labels.text(label, `${module.name.slice(4)}=${VALUE_TEXT[value]}`, !compact && typeof value === 'number' ? (value ? '选 I1' : '选 I0') : undefined, chosen)
          }
        } else if (module.kind === 'pad') {
          const value = display(result, module.ports[0]!.net)
          label.priority = compact ? 0 : 125
          this.labels.text(label, module.name, VALUE_TEXT[value], activeStages(design, module).has(stage), value)
        } else {
          const active = activeStages(design, module).has(stage)
          const used = isUsed(module) || module.kind === 'block'
          const minor = ['and', 'or', 'not', 'mux', 'select'].includes(module.kind)
          // 当前模块 > 活动端口 > 活动连线 > 其他。
          label.priority = module.kind === 'switch' ? (compact ? 0 : active ? 24 : 6)
            : module.kind === 'cfg' ? (used ? (compact ? 20 : 70) : compact ? 0 : 6)
            : module.kind === 'block' ? 150
            : !used ? (compact && !unusedOnly && module.kind !== 'slice' ? 0 : 56)
            : compact && minor ? (focus.kind === 'slice' ? (active ? 54 : 32) : active ? 88 : 62)
            : active ? 130 : 80
          const value = module.kind === 'cfg' ? String(module.value) : undefined
          this.labels.text(label, compact ? shortTitle(module.name) : module.name, value, active && used, module.value)
        }
      } else {
        const id = entry.type === 'pin' ? entry.pin.net : entry.wire.net
        const value = entry.type === 'pin' ? displayPort(result, entry.pin) : display(result, id)
        const net = design.nets[id]!
        const active = typeof value === 'number' && net.at === stage && net.constant === undefined
        if (entry.type === 'pin') {
          const { boundary, name } = entry.pin
          const role = value === 'unused' ? 0 : net.constant !== undefined ? 1 : active ? 3 : 2
          label.priority = compact
            ? (boundary ? [unusedOnly ? 58 : 0, unusedOnly ? 58 : 30, 92, 120] : [0, 0, 0, 88])[role]!
            : (boundary ? [22, 58, 92, 120] : [8, 40, 62, 88])[role]!
          this.labels.text(label, name, VALUE_TEXT[value], active, value)
        } else {
          const path = paths(design, this.layout!).byNet.get(id)
          const spotted = !!this.spot && path?.key === this.spot
          label.priority = spotted ? 160 : value === 'unused' || value === 'pending' ? 0 : entry.wire.feedback ? 110 : active ? 84 : compact ? 0 : 30
          const name = spotted ? path!.name : entry.wire.feedback ? `反馈 ${feedbackName(design, id)}` : ''
          this.labels.text(label, name, VALUE_TEXT[value], active, value)
        }
      }
    }
  }

  // ---------- 相机、渲染、拾取 ----------

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.host
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.labels.resize(w, h)
    const compact = w < 500
    if (compact !== this.compact) {
      this.compact = compact
      this.paint()
    }
    if (!this.touched) this.fit(false)
    this.invalidate()
  }

  private fit(animate: boolean): void {
    const scene = this.layout
    const { clientWidth: width, clientHeight: height } = this.host
    if (!scene || !width || !height) return
    const chip = scene.focus.kind === 'chip'
    // 画布够宽时把父级轮廓一并收进画面。
    const parent = width >= 500 ? scene.rings[0] : undefined
    const { x, y, w, h } = parent?.rect ?? scene.bounds
    const corners: THREE.Vector3[] = []
    for (const cx of [x, x + w]) for (const cy of [y, y + h]) for (const z of chip ? [-4, 4] : [0.5]) corners.push(world(cx, cy, z))

    // 内层近俯视以保证可读，总览斜视以露出剖面。
    const direction = (chip ? new THREE.Vector3(0.38, 1, 0.85) : new THREE.Vector3(0, 1, 0.27)).normalize()
    const camera = this.camera.clone()
    const target = world(x + w / 2, y + h / 2)
    const gutterX = chip ? 10 : parent ? 34 : 32
    const gutterY = chip ? 10 : parent ? 34 : 36
    const roomX = Math.max(0.3, 1 - (2 * gutterX) / width)
    const roomY = Math.max(0.3, 1 - (2 * gutterY) / height)
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    let distance = Math.max(w, h) * 2.5
    for (let round = 0; round < 12; round++) {
      camera.position.copy(target).addScaledVector(direction, distance)
      camera.lookAt(target)
      camera.updateMatrixWorld()
      const box = new THREE.Box3().setFromPoints(corners.map((c) => c.clone().project(camera)))
      const ox = (box.min.x + box.max.x) / 2
      const oy = (box.min.y + box.max.y) / 2
      target
        .addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), ox * distance * tan * camera.aspect)
        .addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), oy * distance * tan)
      distance *= Math.max((box.max.x - box.min.x) / 2 / roomX, (box.max.y - box.min.y) / 2 / roomY)
    }
    const position = target.clone().addScaledVector(direction, distance)
    this.controls.minDistance = distance * 0.06
    this.controls.maxDistance = distance * 2.5

    if (animate && !this.motion.matches) {
      // 换层时从稍远处推进，不沿用上一层无关的坐标。
      const start = target.clone().addScaledVector(direction, distance * 1.35)
      this.camera.position.copy(start)
      this.controls.target.copy(target)
      this.tween = { start: performance.now(), from: [start, target.clone()], to: [position, target] }
    } else {
      this.tween = null
      this.camera.position.copy(position)
      this.controls.target.copy(target)
    }
    this.controls.update()
    this.invalidate()
  }

  private render(now: number): void {
    this.frame = 0
    const { tween } = this
    if (tween) {
      const t = THREE.MathUtils.clamp((now - tween.start) / 420, 0, 1)
      const eased = 1 - (1 - t) ** 3
      this.camera.position.lerpVectors(tween.from[0], tween.to[0], eased)
      this.controls.target.lerpVectors(tween.from[1], tween.to[1], eased)
      if (t === 1) this.tween = null
      this.controls.update()
    }
    this.camera.lookAt(this.controls.target)
    this.camera.updateMatrixWorld()
    this.placePulses()
    this.renderer.render(this.scene, this.camera)
    this.labels.place(this.camera)
    this.renders++
    if (this.tween) this.invalidate()
  }

  private placePulses(): void {
    const mesh = this.pulseMesh
    if (!mesh) return
    const visible = !this.motion.matches && this.progress > 0 && this.progress < 1
    mesh.count = visible ? this.moving.length : 0
    if (!visible) return
    const size = this.wireWidth() * 2
    const matrix = new THREE.Matrix4().makeScale(size, size, size)
    this.moving.forEach((wire, i) => {
      const [x, y] = along(wire.points, this.progress)
      mesh.setMatrixAt(i, matrix.setPosition(world(x, y, wire.z + 0.35)))
    })
    mesh.instanceMatrix.needsUpdate = true
  }

  private bindPointer(canvas: HTMLCanvasElement): void {
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const hit = (event: PointerEvent): Box | undefined => {
      const rect = canvas.getBoundingClientRect()
      if (this.layout?.focus.kind === 'chip') {
        let nearest: Box | undefined
        let reach = BLOCK_REACH
        for (const { box } of this.boxes) {
          if (box.tone !== 'block') continue
          const [cx, cy] = centerOf(box.rect)
          const p = world(cx, cy, box.z + box.height).project(this.camera)
          const x = rect.left + ((p.x + 1) / 2) * rect.width
          const y = rect.top + ((1 - p.y) / 2) * rect.height
          const distance = Math.hypot(event.clientX - x, event.clientY - y)
          if (distance < reach) {
            reach = distance
            nearest = box
          }
        }
        if (nearest) return nearest
      }
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(pointer, this.camera)
      for (const { object, instanceId } of raycaster.intersectObjects(this.boxMeshes, false)) {
        const box = (object.userData.boxes as Box[])[instanceId!]!
        if (box.open || box.module || TILE_INFO[box.tone]) return box
      }
      return undefined
    }
    let down: { x: number; y: number; id: number } | null = null
    canvas.addEventListener('pointerdown', (e) => {
      // 第二根手指表示缩放，不算点击。
      down = down ? null : { x: e.clientX, y: e.clientY, id: e.pointerId }
    })
    canvas.addEventListener('pointercancel', () => (down = null))
    canvas.addEventListener('pointerup', (e) => {
      const start = down
      down = null
      if (!start || start.id !== e.pointerId || e.button !== 0) return
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) return
      const box = hit(e)
      if (!box) return
      if (box.open) this.events.open(box.open)
      else this.events.info(box.module ? this.describe(box.module) : TILE_INFO[box.tone]!)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons === 0 && e.pointerType === 'mouse') canvas.style.cursor = hit(e) ? 'pointer' : 'grab'
    })
  }

  private describe(module: Module): string {
    if (module.kind === 'cfg') return `${module.name}：配置位，值为 ${module.value}。`
    const result = this.result!
    const ports = module.ports.map((p) => {
      const value: Shown = displayPort(result, p)
      return `${p.name}=${value === 'unused' ? '未使用' : VALUE_TEXT[value]}`
    })
    return `${module.name}：${ports.join('，')}。`
  }

  private bindContextLoss(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.host.dataset.lost = 'true'
      // 趁上下文已失效就释放：留到恢复后再删，会拿新上下文去删旧对象。
      this.clear()
      for (const geometry of [...Object.values(this.shapes), this.sphere, this.segmentBox]) geometry.dispose()
      for (const material of [this.solid, this.translucent, this.flat, this.pulseMaterial]) material.dispose()
    })
    canvas.addEventListener('webglcontextrestored', () => {
      delete this.host.dataset.lost
      if (this.layout) this.build(this.layout)
      this.paint()
      this.invalidate()
    })
  }

  /** 仅供开发期验收：读回实际写进 GPU 缓冲的颜色，不重新推算。 */
  inspect() {
    const color = new THREE.Color()
    const rect = this.renderer.domElement.getBoundingClientRect()
    return {
      focus: this.layout?.focus.id,
      renders: this.renders,
      memory: { ...this.renderer.info.memory },
      wires: this.segments.map(({ wire, index }) => {
        this.wireMesh!.getColorAt(index, color)
        return { net: wire.net, idle: !!wire.idle, color: `#${color.getHexString()}`, branch: !!wire.from && this.layout?.focus.kind === 'lut' }
      }),
      pins: (this.layout?.pins ?? []).map((pin, index) => {
        this.pinMesh!.getColorAt(index, color)
        return { net: pin.net, used: pin.used, color: `#${color.getHexString()}` }
      }),
      boxes: this.boxes.filter(({ box }) => box.module && !box.preview).map(({ box }) => {
        const [cx, cy] = centerOf(box.rect)
        const p = world(cx, cy, box.z + box.height).project(this.camera)
        return {
          id: box.module!.id,
          x: rect.left + ((p.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - p.y) / 2) * rect.height,
          active: activeStages(this.result!.design, box.module!).has(this.result!.stage),
        }
      }),
    }
  }
}

function length(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

function along(points: Point[], t: number): Point {
  let total = 0
  for (let i = 1; i < points.length; i++) total += length(points[i - 1]!, points[i]!)
  let remaining = total * t
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const size = length(a, b)
    if (size > 0 && remaining <= size) return [a[0] + ((b[0] - a[0]) * remaining) / size, a[1] + ((b[1] - a[1]) * remaining) / size]
    remaining -= size
  }
  return points.at(-1)!
}

function rectEdges(items: { rect: Rect; z: number }[]): THREE.Vector3[] {
  return items.flatMap(({ rect: { x, y, w, h }, z }) => {
    const c = [world(x, y, z), world(x + w, y, z), world(x + w, y + h, z), world(x, y + h, z)] as const
    return [c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0]]
  })
}

const GATE_SHORT: Record<string, string> = { AND: '与', OR: '或', NOT: '非' }

function shortTitle(name: string): string {
  return GATE_SHORT[name] ?? name.replace(/（.*）$/, '').replace(' · 运算', ' ·').replace(' · 进位', ' · ')
}

function feedbackName(design: Design, net: number): string {
  const r = design.routes.find((e) => e.type === 'feedback'
    && (e.src === net || e.dst === net || e.sb.ports.some((p) => p.net === net)))
  return r ? r.sb.key.replace('sb_back_', '') : ''
}
