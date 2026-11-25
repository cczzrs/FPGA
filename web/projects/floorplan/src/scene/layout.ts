import { child, type Design, type Kind, type Module, type Port } from '../model/cells.ts'
import { chipLayout } from './floorplan.ts'
import { route, type Connection, type Point, type Rect, type Side, type Terminal } from './route.ts'

export type Shape = 'box' | 'mux' | 'and' | 'or' | 'xor' | 'not'
export type Tone =
  | Kind | 'logic' | 'io' | 'bram' | 'dsp' | 'metal' | 'metalTop' | 'die' | 'substrate' | 'package' | 'ball'

export interface Box {
  rect: Rect
  z: number
  height: number
  shape: Shape
  tone: Tone
  module?: Module
  /** 点击时进入的模块。 */
  open?: string
  /** 只作轮廓的已展开子模块。 */
  group?: boolean
  preview?: boolean
}

export interface Pin extends Port {
  module: Module
  at: Point
  side: Side
  boundary: boolean
}

export interface Wire {
  net: number
  points: Point[]
  z: number
  from?: Module
  to?: Module
  /** Slice 外经互连返回的反馈线。 */
  feedback?: boolean
  /** 通向未选用端口的支线。 */
  idle?: boolean
}

export interface Note {
  text: string
  at: Point
  z: number
}

export interface Scene {
  focus: Module
  frame: Rect
  bounds: Rect
  boxes: Box[]
  pins: Pin[]
  wires: Wire[]
  junctions: { net: number; at: Point; z: number }[]
  rings: { module: Module; rect: Rect }[]
  notes: Note[]
}

type Place = readonly [x: number, y: number, w: number, h: number]
interface Plan {
  w: number
  h: number
  place: Record<string, Place>
  /** 边界端口沿所在边的坐标。 */
  edge?: Record<string, number>
}

export const WIRE_Z = 0.8
const LETTER = ['A', 'B', 'C', 'D']
const AMD_LANE = (i: number) => 12 + 26 * i

function plan(module: Module): Plan {
  switch (module.kind) {
    case 'block':
      return module.children.length === 2
        ? { w: 68, h: 70, place: { s0: [12, 5, 22, 28], s1: [38, 37, 22, 28] }, edge: { 'S0.CIN': 23, 'S0.COUT': 23, 'S1.CIN': 49, 'S1.COUT': 49 } }
        : { w: 62, h: 92, place: Object.fromEntries([0, 1, 2, 3].map((i) => [`s${i}`, [14, 5 + 22 * i, 32, 16]])) }
    case 'slice':
      return module.children.some((c) => c.key === 'carry4') ? amdSlice() : ecp5Slice()
    case 'carry4':
      return {
        w: 48, h: 106,
        place: { c0: [12, 1, 6, 6], ...Object.fromEntries([0, 1, 2, 3].map((i) => [`bit${i}`, [15, 11 + 24 * i, 18, 16]])) },
        edge: { CI: 5, CO3: 24 },
      }
    case 'carrybit': {
      const equivalent = module.children.some((c) => c.key === 'fa')
      const low = equivalent ? 22 : 6
      return {
        w: 56, h: equivalent ? 58 : 42,
        place: { fa: [20, 5, 16, 13], co: [23, low, 10, 10], sum: [23, low + 18, 10, 9] },
        edge: { CI: 10, CO: 28 },
      }
    }
    case 'ccu': {
      const equivalent = module.children.some((c) => c.key === 'fa')
      const low = equivalent ? 23 : 6
      return {
        w: 62, h: equivalent ? 62 : 45,
        place: {
          fa: [30, 5, 16, 13], carryEnable: [5, low + 8, 4, 3], generate: [15, low, 7, 6],
          gated: [15, low + 19, 7, 6], co: [34, low, 10, 10], sum: [34, low + 19, 10, 9],
        },
        edge: { CI: 11, CO: 39 },
      }
    }
    case 'adder':
      return {
        w: 50, h: 34,
        place: { p: [8, 23, 8, 7], sum: [28, 22, 8, 7], generate: [8, 3, 7, 6], pass: [19, 12, 7, 6], carry: [36, 6, 7, 6] },
      }
    case 'xor':
      return { w: 40, h: 28, place: { na: [6, 19, 5, 4], nb: [6, 5, 5, 4], left: [16, 16, 7, 7], right: [16, 4, 7, 7], or: [28, 10, 7, 7] } }
    case 'mux':
      return { w: 40, h: 28, place: { ns: [6, 3, 5, 4], low: [16, 16, 7, 7], high: [16, 4, 7, 7], or: [28, 10, 7, 7] } }
    case 'ff':
      return {
        w: 90, h: 86,
        place: { enable: [8, 22, 8, 10], nr: [8, 8, 5, 4], clear: [24, 20, 7, 7], nc: [8, 66, 5, 4], master: [40, 6, 41, 32], slave: [40, 48, 41, 32] },
      }
    case 'latch':
      return {
        w: 41, h: 32,
        place: { nd: [3, 6, 4, 4], set: [11, 22, 6, 6], reset: [11, 4, 6, 6], orq: [21, 4, 6, 6], notq: [31, 5, 5, 4], orn: [21, 22, 6, 6], notn: [31, 23, 5, 4] },
      }
    case 'select':
    case 'switch':
      return { w: 30, h: 18, place: { enable: [5, 2, 5, 3], pass: [14, 6, 8, 8] } }
    default:
      throw new Error(`${module.kind} 不能展开`)
  }
}

function amdSlice(): Plan {
  const place: Record<string, Place> = { cyinit: [32, 1, 5, 5], carry4: [44, 10, 14, 100] }
  const edge: Record<string, number> = { CIN: 51, COUT: 51, CLK: 3, CE: 5, SR: 7 }
  for (let i = 0; i < 4; i++) {
    const y = AMD_LANE(i)
    const X = LETTER[i]!
    place[`lut${X}`] = [10, y, 15, 14]
    place[`cy0${X}_select`] = [26, y - 3, 3, 2]
    place[`cy0${X}`] = [33, y, 5, 6]
    place[`ffmux${X}`] = [64, y + 4, 5, 6]
    place[`ff${X}`] = [75, y - 1, 12, 10]
    place[`ff5${X}`] = [75, y + 12, 12, 10]
    place[`outmux${X}`] = [94, y + 9, 5, 6]
    for (let n = 1; n <= 6; n++) edge[`${X}${n}`] = y + 14 - 2 * n
    edge[`${X}X`] = y - 1
  }
  place.f7a = [33, AMD_LANE(0) + 17, 5, 6]
  place.f8 = [33, AMD_LANE(1) + 17, 5, 6]
  place.f7b = [33, AMD_LANE(2) + 17, 5, 6]
  return { w: 108, h: 117, place, edge }
}

function ecp5Slice(): Plan {
  const place: Record<string, Place> = { wide0: [60, 34, 6, 8], wide1: [60, 79, 6, 8] }
  for (const i of [0, 1]) {
    const y = i ? 53 : 10
    place[`lut${i}`] = [12, y, 18, 20]
    place[`ccu${i}`] = [38, y, 14, 20]
    place[`fmux${i}`] = [60, y + 7, 5, 6]
    place[`ff${i}`] = [77, y - 3, 12, 16]
  }
  return { w: 100, h: 92, place, edge: { FCI: 45, FCO: 45, CLK: 3, CE: 5, LSR: 7 } }
}

const OPPOSITE: Record<Side, Side> = { l: 'r', r: 'l', t: 'b', b: 't' }

function sideOf(module: Module, name: string, dir: 'in' | 'out'): Side {
  switch (module.kind) {
    case 'mux':
      if (name === 'S') return 'b'
      break
    case 'carrybit':
    case 'ccu':
      if (name === 'CI') return 'b'
      if (name === 'CO') return 't'
      break
    case 'carry4':
      if (name === 'CI') return 'b'
      if (name === 'CO3') return 't'
      break
    case 'slice':
    case 'block':
      if (/(^|\.)(CIN|FCI)$/.test(name)) return 'b'
      if (/(^|\.)(COUT|FCO)$/.test(name)) return 't'
  }
  return dir === 'in' ? 'l' : 'r'
}

function shapeOf(kind: Kind): Shape {
  if (kind === 'mux' || kind === 'select') return 'mux'
  return kind === 'and' || kind === 'or' || kind === 'xor' || kind === 'not' ? kind : 'box'
}

const HEIGHT: Partial<Record<Kind, number>> = {
  block: 2, slice: 2, lut: 3, carry4: 2.4, carrybit: 2.4, ccu: 2.4, ff: 2.4, adder: 1.4, cfg: 1,
}

const portsIn = (module: Module, container: Module, design: Design) =>
  container.kind !== 'block' ? module.ports : module.ports.filter((p) => {
    // 逻辑块层只画用到的信号端口与进位端口，其余端口列在面板里。
    if (/(^|\.)(CIN|COUT|FCI|FCO)$/.test(p.name)) return true
    return p.used && design.nets[p.net]!.constant === undefined
  })

function childPins(design: Design, module: Module, rect: Rect, container: Module): Pin[] {
  const groups: Record<Side, Port[]> = { l: [], r: [], t: [], b: [] }
  for (const p of portsIn(module, container, design)) groups[sideOf(module, p.name, p.dir)].push(p)
  const pins: Pin[] = []
  for (const side of ['l', 'r', 't', 'b'] as const) {
    const list = groups[side]
    list.forEach((p, i) => {
      const horizontal = side === 't' || side === 'b'
      let offset = Math.round(((horizontal ? rect.w : rect.h) * (i + 1)) / (list.length + 1))
      let coordinate = horizontal ? rect.x + offset : rect.y + rect.h - offset
      if (module.kind === 'carry4' && container.kind === 'slice' && !horizontal) {
        const match = /^(CO|DI|S|O)(\d)$/.exec(p.name)
        if (match) {
          offset = { S: 9, DI: 3, O: 9, CO: 5 }[match[1] as 'S' | 'DI' | 'O' | 'CO']
          coordinate = AMD_LANE(Number(match[2])) + offset
        } else if (p.name === 'CYINIT') coordinate = rect.y + 1
      }
      const at: Point = side === 'l' ? [rect.x, coordinate]
        : side === 'r' ? [rect.x + rect.w, coordinate]
        : side === 't' ? [coordinate, rect.y + rect.h]
        : [coordinate, rect.y]
      pins.push({ module, ...p, at, side, boundary: false })
    })
  }
  return pins
}

/** 边界端口对齐它连到的子端口，再按最小间距错开。 */
function boundaryPins(design: Design, focus: Module, size: Plan, inner: Pin[]): Pin[] {
  const pins: Pin[] = []
  const ports = portsIn(focus, focus, design)
  for (const side of ['l', 'r', 't', 'b'] as const) {
    const horizontal = side === 't' || side === 'b'
    const limit = horizontal ? size.w : size.h
    const taken = new Set<number>()
    const list = ports.filter((p) => sideOf(focus, p.name, p.dir) === side).map((p, i, all) => {
      const fixed = size.edge?.[p.name]
      const peers = inner.filter((q) => q.net === p.net && q.dir === p.dir)
      const owner = /^S(\d)\.(.+)$/.exec(p.name)
      const peer = (owner && peers.find((q) => q.module.key === `s${owner[1]}` && q.name === owner[2])) || peers[0]
      const want = fixed ?? (peer ? peer.at[horizontal ? 0 : 1] : Math.round((limit * (all.length - i)) / (all.length + 1)))
      return { p, want, fixed: fixed !== undefined }
    })
    const gap = list.length * 2 < limit - 2 ? 2 : 1
    const free = (c: number) => {
      if (c < 1 || c > limit - 1) return false
      for (let d = 1 - gap; d < gap; d++) if (taken.has(c + d)) return false
      return true
    }
    for (const { p, want, fixed } of [...list].sort((a, b) => Number(b.fixed) - Number(a.fixed))) {
      let coordinate = want
      for (let d = 0; !(fixed ? !taken.has(coordinate) : free(coordinate)); d++) {
        if (d > limit) throw new Error(`${focus.id} 的端口放不下`)
        if (free(want - d)) coordinate = want - d
        else if (free(want + d)) coordinate = want + d
      }
      taken.add(coordinate)
      const at: Point = side === 'l' ? [0, coordinate]
        : side === 'r' ? [size.w, coordinate]
        : side === 't' ? [coordinate, size.h]
        : [coordinate, 0]
      pins.push({ module: focus, ...p, at, side, boundary: true })
    }
  }
  return pins
}

function terminal(pin: Pin): Terminal {
  // 边界端口向框内引线，子模块端口向框外引线。
  const side = pin.boundary ? OPPOSITE[pin.side] : pin.side
  const [x, y] = pin.at
  const exit: Point = side === 'l' ? [x - 1, y] : side === 'r' ? [x + 1, y] : side === 't' ? [x, y + 1] : [x, y - 1]
  return { at: pin.at, exit, side, idle: !pin.used }
}

function schematic(design: Design, focus: Module): Scene {
  const size = plan(focus)
  const boxes: Box[] = []
  const inner: Pin[] = []
  const obstacles: Rect[] = []

  const put = (container: Module, layout: Plan, dx: number, dy: number): void => {
    for (const module of container.children) {
      const place = layout.place[module.key]
      if (!place) throw new Error(`${module.id} 没有版图位置`)
      const [x, y, w, h] = place
      const rect = { x: x + dx, y: y + dy, w, h }
      const open = module.children.length ? module.id : undefined
      if (focus.kind === 'ff' && module.kind === 'latch') {
        boxes.push({ rect, z: 0, height: 0.1, shape: 'box', tone: 'latch', module, open, group: true })
        put(module, plan(module), rect.x, rect.y)
        continue
      }
      const height = HEIGHT[module.kind] ?? 1.8
      boxes.push({ rect, z: 0, height, shape: shapeOf(module.kind), tone: module.kind, module, open })
      obstacles.push(rect)
      inner.push(...childPins(design, module, rect, container))
      if (module.kind === 'slice') boxes.push(...preview(module, rect, height))
    }
  }
  put(focus, size, 0, 0)

  const boundary = boundaryPins(design, focus, size, inner)
  const connections = new Map<number, { sources: Pin[]; sinks: Pin[] }>()
  for (const pin of [...boundary, ...inner]) {
    let entry = connections.get(pin.net)
    if (!entry) connections.set(pin.net, (entry = { sources: [], sinks: [] }))
    const drives = pin.boundary ? pin.dir === 'in' : pin.dir === 'out'
    ;(drives ? entry.sources : entry.sinks).push(pin)
  }
  const wanted: Connection[] = []
  for (const [net, { sources, sinks }] of connections) {
    if (sources.length && sinks.length) wanted.push({ net, sources: sources.map(terminal), sinks: sinks.map(terminal) })
  }
  const routed = route(size.w, size.h, obstacles, wanted)

  return {
    focus,
    frame: { x: 0, y: 0, w: size.w, h: size.h },
    bounds: { x: 0, y: 0, w: size.w, h: size.h },
    boxes,
    pins: [...boundary, ...inner],
    wires: routed.paths.map((p) => ({ ...p, z: WIRE_Z })),
    junctions: routed.junctions.map((j) => ({ ...j, z: WIRE_Z })),
    rings: [],
    notes: [],
  }
}

/** 在上一层提前露出下一层的轮廓。 */
export function preview(module: Module, rect: Rect, z: number): Box[] {
  const inner = plan(module)
  const sx = rect.w / inner.w
  const sy = rect.h / inner.h
  return module.children.flatMap((c) => {
    const place = inner.place[c.key]
    if (!place || c.kind === 'cfg') return []
    const [x, y, w, h] = place
    return [{
      rect: { x: rect.x + x * sx, y: rect.y + y * sy, w: w * sx, h: h * sy },
      z, height: rect.w > 10 ? 0.45 : 0.16, shape: shapeOf(c.kind), tone: c.kind, module: c, open: module.id, preview: true,
    }]
  })
}

function lutLayout(lut: Module): Scene {
  const inputs = lut.ports.filter((p) => p.dir === 'in')
  const levels = inputs.length
  const pitch = levels === 6 ? 1.4 : 4.2
  const dx = levels === 6 ? 15 : 16
  const first = 7
  const leaves = 2 ** levels
  const frame = { x: 0, y: 0, w: 12 + levels * dx, h: first * 2 + (leaves - 1) * pitch }
  const boxes: Box[] = []
  const wires: Wire[] = []
  const pins: Pin[] = []

  let row = Array.from({ length: leaves }, (_, i) => {
    const module = child(lut, `bit${i}`)
    const size = pitch * 0.78
    const y = first + i * pitch
    boxes.push({ rect: { x: 5 - size, y: y - size / 2, w: size, h: size }, z: 0, height: 0.8, shape: 'box', tone: 'cfg', module })
    return { module, at: [5, y] as Point, net: module.ports[0]!.net }
  })

  inputs.forEach((input, level) => {
    const x = 5 + (level + 0.8) * dx
    const size = levels === 6 ? Math.min(pitch * 2 ** (level + 1) * 0.85, 2.2 + level) : 5 + level * 0.6
    const next: typeof row = []
    for (let i = 0; i < row.length; i += 2) {
      const module = child(lut, `m${level}_${i / 2}`)
      const y = (row[i]!.at[1] + row[i + 1]!.at[1]) / 2
      const w = size * 0.85
      boxes.push({ rect: { x: x - w / 2, y: y - size / 2, w, h: size }, z: 0, height: 1, shape: 'mux', tone: 'mux', module, open: module.id })
      for (const j of [0, 1]) {
        const source = row[i + j]!
        const entry: Point = [x - w / 2, y + (j ? 1 : -1) * size * 0.25]
        wires.push({ net: source.net, points: [source.at, entry], z: 0.55, from: source.module, to: module })
      }
      next.push({ module, at: [x + w / 2, y], net: module.ports.find((p) => p.dir === 'out')!.net })
    }
    const pin: Pin = { ...input, module: lut, at: [x, 0], side: 'b', boundary: true }
    pins.push(pin)
    // 地址线从各级选择器下方穿过。
    wires.push({ net: input.net, points: [pin.at, [x, next.at(-1)!.at[1]]], z: 0.15 })
    row = next
  })

  const [main, tap] = lut.ports.filter((p) => p.dir === 'out')
  const root = row[0]!
  pins.push({ ...main!, module: lut, at: [frame.w, root.at[1]], side: 'r', boundary: true })
  wires.push({ net: main!.net, points: [root.at, [frame.w, root.at[1]]], z: 0.55, from: root.module, idle: !main!.used })

  const tapModule = child(lut, `m${levels === 6 ? 4 : 1}_0`)
  const tapBox = boxes.find((b) => b.module === tapModule)!.rect
  const tx = tapBox.x + tapBox.w
  const ty = tapBox.y + tapBox.h / 2
  pins.push({ ...tap!, module: lut, at: [frame.w, 3], side: 'r', boundary: true })
  wires.push({ net: tap!.net, points: [[tx, ty], [tx + 3, ty], [tx + 3, 3], [frame.w, 3]], z: 0.65, from: tapModule, idle: !tap!.used })

  return {
    focus: lut, frame, bounds: { ...frame }, boxes, pins, wires,
    junctions: [{ net: tap!.net, at: [tx, ty], z: 0.65 }],
    rings: [], notes: [],
  }
}

function addFeedback(design: Design, scene: Scene): void {
  if (scene.focus.kind !== 'block' && scene.focus.kind !== 'slice') return
  let k = 0
  for (const r of design.routes) {
    if (r.type !== 'feedback') continue
    const out = scene.pins.find((p) => p.boundary && p.dir === 'out' && p.side === 'r' && p.net === r.src)
    const back = scene.pins.find((p) => p.boundary && p.dir === 'in' && p.side === 'l' && p.net === r.dst)
    if (!out || !back) continue
    const gap = 9 + k++ * 2
    const right = scene.frame.w + gap
    const top = scene.frame.h + gap - 5
    scene.wires.push({ net: r.src, points: [out.at, [right, out.at[1]], [right, top], [0, top]], z: WIRE_Z, feedback: true })
    scene.wires.push({ net: r.dst, points: [[0, top], [-gap, top], [-gap, back.at[1]], back.at], z: WIRE_Z, feedback: true })
    scene.bounds = { x: -gap, y: 0, w: right + gap, h: top }
  }
}

function addRings(scene: Scene): void {
  const { bounds, focus } = scene
  const step = Math.max(bounds.w, bounds.h) * 0.07
  let parent = focus.parent
  for (let i = 1; parent && i <= 2; i++, parent = parent.parent) {
    const pad = step * i
    scene.rings.push({ module: parent, rect: { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 } })
  }
}

const cache = new WeakMap<Module, Scene>()

export function layout(design: Design, focus: Module): Scene {
  let scene = cache.get(focus)
  if (scene) return scene
  if (focus.kind === 'chip') scene = chipLayout(design)
  else {
    scene = focus.kind === 'lut' ? lutLayout(focus) : schematic(design, focus)
    addFeedback(design, scene)
    addRings(scene)
  }
  cache.set(focus, scene)
  return scene
}
