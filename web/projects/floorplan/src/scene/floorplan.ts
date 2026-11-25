import type { Design, Module } from '../model/cells.ts'
import type { Box, Pin, Scene, Tone, Wire } from './layout.ts'
import { preview } from './layout.ts'
import type { Point, Rect, Side } from './route.ts'

const PITCH = 6
const TILE = 4
const COLUMNS = 14
const ROWS = 12
const BLOCK = { column: 7, row: 6 }
/** 剖切线：只有此线以后的区域保留上层金属与封装盖。 */
const CUT = 65
const WIRE = 2.5
/** 总览里相邻走线的间距，须明显大于线宽。 */
const TRACK = 0.75

const center = (index: number) => PITCH * (index + 1)

function tile(design: Design, column: number, row: number): Tone {
  // AMD ASMBL 按列排布；ECP5 的 EBR、sysDSP 按行穿插。
  if (design.arch === 'amd') {
    if (column === 2 || column === 9) return 'bram'
    if (column === 5 || column === 11) return 'dsp'
  } else {
    if (row === 2 || row === 9) return 'bram'
    if (row === 4) return 'dsp'
  }
  return 'logic'
}

/**
 * 竖直走线排轨：spans 为每根线竖段的两端 y。入口上方的线越靠上越贴近逻辑块，
 * 下方的反之，这样横段不会穿过别人的竖段；竖段区间重叠的线绝不共用一条轨。
 */
function tracks(spans: [number, number][]): number[] {
  const order = spans.map((span, i) => ({ i, above: span[0] > span[1], top: Math.max(...span) }))
  order.sort((a, b) => Number(b.above) - Number(a.above) || (a.above ? b.top - a.top : a.top - b.top))
  const taken: [number, number][][] = []
  const ranks: number[] = []
  for (const { i } of order) {
    const lo = Math.min(...spans[i]!)
    const hi = Math.max(...spans[i]!)
    let rank = 0
    while (taken[rank]?.some(([a, b]) => lo <= b + TRACK && hi >= a - TRACK)) rank++
    ;(taken[rank] ??= []).push([lo, hi])
    ranks[i] = rank
  }
  return ranks
}

export function chipLayout(design: Design): Scene {
  const { root, idle, routes } = design
  const right = center(COLUMNS)
  const top = center(ROWS)
  const boxes: Box[] = []
  const pins: Pin[] = []
  const wires: Wire[] = []
  const box = (rect: Rect, z: number, height: number, tone: Tone, extra: Partial<Box> = {}) =>
    boxes.push({ rect, z, height, shape: 'box', tone, ...extra })
  const square = (x: number, y: number, size = TILE): Rect => ({ x: x - size / 2, y: y - size / 2, w: size, h: size })

  // 剖面：焊球、封装基板、硅片、金属互连、残留的封装盖。
  box({ x: -10, y: -10, w: right + 20, h: top + 20 }, -4.6, 2.2, 'substrate')
  box({ x: -4, y: -4, w: right + 8, h: top + 8 }, -2.4, 2.35, 'die')
  for (let x = -5; x <= right + 5; x += 8) {
    for (const y of [-7, top + 7]) box(square(x, y, 2.6), -6.2, 1.6, 'ball')
  }
  box({ x: -10, y: top + 6, w: right + 20, h: 4 }, -2.4, 9, 'package')
  box({ x: -10, y: CUT, w: 4, h: top + 6 - CUT }, -2.4, 9, 'package')
  box({ x: -10, y: top + 2, w: right + 20, h: 4 }, 5.2, 1.4, 'package')

  for (let i = 0; i <= COLUMNS; i++) {
    const x = center(i) - PITCH / 2
    box({ x: x - 0.12, y: 1, w: 0.24, h: top - 2 }, 0, 0.35, 'metal')
  }
  for (let i = 0; i <= ROWS; i++) {
    const y = center(i) - PITCH / 2
    box({ x: 2.2, y: y - 0.12, w: right - 4.4, h: 0.24 }, 0.35, 0.25, 'metal')
  }
  for (let x = 3; x < right - 2; x += 2) box({ x, y: CUT, w: 0.5, h: top + 1 - CUT }, 2.8, 0.3, 'metalTop')
  for (let y = CUT + 1; y < top; y += 3) box({ x: 2, y, w: right - 4, h: 0.6 }, 3.4, 0.3, 'metalTop')

  const helper = design.roles.get('helper')
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      if (column === BLOCK.column && (row === BLOCK.row || (helper && row === BLOCK.row + 1))) continue
      const tone = tile(design, column, row)
      const rect = square(center(column), center(row))
      box(rect, 0, tone === 'logic' ? 1.1 : 1.6, tone, tone === 'logic' ? { open: idle.id } : {})
    }
    for (const x of [0, right]) box(square(x, center(row), 3.2), 0, 1.3, 'io')
  }
  if (design.arch === 'ecp5') {
    for (let column = 0; column < COLUMNS; column++) {
      for (const y of [0, top]) box(square(center(column), y, 3.2), 0, 1.3, 'io')
    }
  }

  const placed = new Map<Module, Rect>()
  const putBlock = (module: Module, row: number) => {
    const rect = square(center(BLOCK.column), center(row))
    placed.set(module, rect)
    box(rect, 0, 2.2, 'block', { module, open: module.id })
    const count = module.children.length
    module.children.forEach((slice, i) => {
      const inner: Rect = count === 2
        ? { x: rect.x + 0.35 + i * 1.75, y: rect.y + 0.35 + i * 1.75, w: 1.55, h: 1.55 }
        : { x: rect.x + 0.7, y: rect.y + 0.2 + i * 0.94, w: 2.6, h: 0.8 }
      box(inner, 2.2, 0.2, 'slice', { module: slice, open: module.id, preview: true })
      boxes.push(...preview(slice, inner, 2.4).map((b) => ({ ...b, open: module.id })))
    })
  }
  const block = design.roles.get('block')!
  putBlock(block, BLOCK.row)
  if (helper) {
    putBlock(helper, BLOCK.row + 1)
    const carry = helper.ports.find((p) => p.name === 'S0.CIN')!
    const x = center(BLOCK.column) - 1.1
    wires.push({ net: carry.net, points: [[x, center(BLOCK.row) + 2], [x, center(BLOCK.row + 1) - 2]], z: WIRE })
  }

  const left = center(BLOCK.column) - TILE / 2
  const east = center(BLOCK.column) + TILE / 2
  const inputs = routes.filter((r) => r.type === 'in')
  const outputs = routes.filter((r) => r.type === 'out')
  const backs = routes.filter((r) => r.type === 'feedback')
  const entries = [...inputs, ...backs]
  const entryY = (i: number) => center(BLOCK.row) + 1.75 - i * (3.5 / Math.max(entries.length - 1, 1))
  const sources = new Map<number, Point>()
  outputs.forEach(({ src }, i) => {
    const fromHelper = helper?.ports.some((p) => p.dir === 'out' && p.net === src)
    sources.set(src, [east, fromHelper ? center(BLOCK.row + 1) : center(BLOCK.row) + 1.5 - i * 0.9])
  })

  const padRow = (i: number, count: number) => center(BLOCK.row + Math.floor(count / 2) - i) - PITCH / 2
  const node = (module: Module, at: Point) => box(square(at[0], at[1], 0.5), WIRE - 0.2, 0.6, 'switch', { module, open: module.id })
  const pin = (module: Module, at: Point, side: Side) => {
    const p = module.ports[0]!
    pins.push({ ...p, module, at, side, boundary: false })
  }

  const inRanks = tracks(inputs.map((_, i) => [padRow(i, inputs.length), entryY(i)]))
  inputs.forEach(({ src, dst, pad, sb, cb }, i) => {
    const y = padRow(i, inputs.length)
    const track = left - 0.9 - inRanks[i]! * TRACK
    const turn: Point = [track, y]
    const landing: Point = [left - 0.35, entryY(i)]
    box({ x: -2.2, y: y - 0.9, w: 4.4, h: 1.8 }, 0, 1.9, 'pad', { module: pad })
    pin(pad!, [2.2, y], 'r')
    node(sb, turn)
    node(cb!, landing)
    const middle = sb.ports.find((p) => p.dir === 'out')!.net
    wires.push({ net: src, points: [[2.2, y], turn], z: WIRE, to: sb })
    wires.push({ net: middle, points: [turn, [track, landing[1]], landing], z: WIRE, from: sb, to: cb })
    wires.push({ net: dst, points: [landing, [left + 0.2, landing[1]]], z: WIRE, from: cb })
  })

  const outRanks = tracks(outputs.map(({ src }, i) => [padRow(i, outputs.length), sources.get(src)![1]]))
  outputs.forEach(({ src, dst, pad, sb }, i) => {
    const y = padRow(i, outputs.length)
    const start = sources.get(src)!
    const track = east + 0.9 + outRanks[i]! * TRACK
    const turn: Point = [track, y]
    box({ x: right - 2.2, y: y - 0.9, w: 4.4, h: 1.8 }, 0, 1.9, 'pad', { module: pad })
    pin(pad!, [right - 2.2, y], 'l')
    node(sb, turn)
    wires.push({ net: src, points: [start, [track, start[1]], turn], z: WIRE, to: sb })
    wires.push({ net: dst, points: [turn, [right - 2.2, y]], z: WIRE, from: sb })
  })

  backs.forEach(({ src, dst, sb, cb }, i) => {
    const start = sources.get(src)!
    // 反馈绕到所有输入、输出走线外侧，越晚的越靠外。
    const track = east + 0.9 + (Math.max(-1, ...outRanks) + 1 + i) * TRACK
    // 横线放在逻辑块上方两条引脚行之间，不与引脚引线重合。
    const high = center(BLOCK.row) + TILE / 2 + 1.6 + i * TRACK
    const turn: Point = [track, high]
    const west = left - 0.9 - (Math.max(-1, ...inRanks) + 1 + i) * TRACK
    const landing: Point = [left - 0.3, entryY(inputs.length + i)]
    node(sb, turn)
    node(cb!, landing)
    const middle = sb.ports.find((p) => p.dir === 'out')!.net
    wires.push({ net: src, points: [start, [track, start[1]], turn], z: WIRE + 0.1, to: sb, feedback: true })
    wires.push({ net: middle, points: [turn, [west, high], [west, landing[1]], landing], z: WIRE + 0.1, from: sb, to: cb, feedback: true })
    wires.push({ net: dst, points: [landing, [left + 0.2, landing[1]]], z: WIRE + 0.1, from: cb, feedback: true })
  })

  return {
    focus: root,
    frame: { x: -4, y: -4, w: right + 8, h: top + 8 },
    bounds: { x: -10, y: -10, w: right + 20, h: top + 20 },
    boxes, pins, wires, junctions: [], rings: [],
    notes: [
      { text: 'I/O', at: [0, center(0)], z: 1.3 },
      { text: '可编程互连', at: [center(3) + PITCH / 2, center(1) + PITCH / 2], z: 0.6 },
      // 五个分区标签彼此错开，也避开两侧引脚和中央逻辑块。
      { text: '逻辑阵列', at: [center(11) + (design.arch === 'amd' ? PITCH : 0), center(8)], z: 1.1 },
      ...(design.arch === 'amd'
        ? [{ text: '块 RAM', at: [center(9), center(1)] as Point, z: 1.6 },
           { text: 'DSP', at: [center(5), center(9)] as Point, z: 1.6 }]
        : [{ text: '块 RAM（EBR）', at: [center(4), center(9)] as Point, z: 1.6 },
           { text: 'DSP（sysDSP）', at: [center(10), center(4)] as Point, z: 1.6 }]),
    ],
  }
}
