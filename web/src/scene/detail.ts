import * as T from 'three'
import { bit, families, type Snapshot } from '../logic/simulator.ts'
import type { GateGraph, Op } from '../logic/gates.ts'
import type { Jump, Location, SceneAsset, SceneLabel, SceneRoute } from './types.ts'

const pt = (x: number, y: number, z: number) => new T.Vector3(x, y, z)
const jade = '#5aaf88',
  lime = '#cbef92',
  gold = '#d8a466',
  lilac = '#aaa1dd'
type Action = { jump?: Jump; probe?: string; signal?: string }

class Board {
  group = new T.Group()
  labels: SceneLabel[] = []
  routes: SceneRoute[] = []
  textures = new Map<string, T.MeshBasicMaterial>()
  constructor(w: number, d: number) {
    this.box(0, -0.22, 0, w, 0.32, d, '#263139')
    this.box(0, -0.037, 0, w - 0.12, 0.065, d - 0.12, '#41545b')
    this.box(0, 0.015, 0, w - 0.21, 0.065, d - 0.21, '#273938')
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        this.box(sx * (w / 2 - 0.24), 0.065, sz * (d / 2 - 0.24), 0.15, 0.04, 0.15, '#bba976')
      }
  }
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: string, action?: Action) {
    const m = new T.Mesh(
      new T.BoxGeometry(w, h, d),
      new T.MeshStandardMaterial({ color, roughness: 0.54, metalness: 0.21 })
    )
    m.position.set(x, y, z)
    if (action) Object.assign(m.userData, action)
    this.group.add(m)
    return m
  }
  print(text: string, x: number, y: number, z: number, w: number, d: number, color = '#e0efdf') {
    if (typeof document === 'undefined') return
    const key = text + color
    let material = this.textures.get(key)
    if (!material) {
      const c = document.createElement('canvas')
      const g = c.getContext('2d')!
      const font = '600 60px Menlo, monospace'
      g.font = font
      c.width = Math.ceil(g.measureText(text).width) + 10
      c.height = 76
      g.font = font
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillStyle = color
      g.fillText(text, c.width / 2, 39)
      const map = new T.CanvasTexture(c)
      map.colorSpace = T.SRGBColorSpace
      material = new T.MeshBasicMaterial({
        map,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2
      })
      this.textures.set(key, material)
    }
    const canvas = material.map!.image as HTMLCanvasElement
    const ratio = canvas.width / canvas.height
    const m = new T.Mesh(new T.PlaneGeometry(Math.min(w, d * ratio), Math.min(d, w / ratio)), material)
    m.rotation.x = -Math.PI / 2
    m.position.set(x, y, z)
    this.group.add(m)
  }
  tag(
    text: string,
    x: number,
    y: number,
    z: number,
    color: string,
    priority: number,
    extra: Partial<SceneLabel> = {}
  ) {
    this.labels.push({ text, at: pt(x, y, z), color, priority, ...extra })
  }
  wire(signal: string, points: T.Vector3[]) {
    this.routes.push({ signal, points })
  }
  term(x: number, z: number, text: string, signal: string, action?: Action) {
    this.box(x, 0.18, z, 0.99, 0.22, 0.55, '#597377', action)
    this.print(text, x, 0.295, z, 0.84, 0.36)
    this.tag(text, x, 0.38, z, '#a8cccb', 3, { signal })
  }
  gate(x: number, z: number, op: Op, key: string, color: string, action: Action, scale = 1) {
    const s = new T.Shape()
    if (op === 'NOT') {
      s.moveTo(-0.46, -0.34)
      s.lineTo(0.34, 0)
      s.lineTo(-0.46, 0.34)
    } else if (op === 'AND' || op === 'NAND') {
      s.moveTo(-0.48, -0.33)
      s.lineTo(0.02, -0.33)
      s.absarc(0.02, 0, 0.33, -Math.PI / 2, Math.PI / 2, false)
      s.lineTo(-0.48, 0.33)
    } else if (op === 'OR' || op === 'XOR') {
      s.moveTo(-0.46, -0.34)
      s.quadraticCurveTo(0.12, -0.38, 0.46, 0)
      s.quadraticCurveTo(0.12, 0.38, -0.46, 0.34)
      s.quadraticCurveTo(-0.22, 0, -0.46, -0.34)
    } else {
      s.moveTo(-0.44, -0.42)
      s.lineTo(0.4, -0.24)
      s.lineTo(0.4, 0.24)
      s.lineTo(-0.44, 0.42)
    }
    s.closePath()
    const geometry = new T.ExtrudeGeometry(s, {
      depth: 0.24,
      bevelEnabled: true,
      bevelThickness: 0.025,
      bevelSize: 0.025,
      bevelSegments: 1,
      curveSegments: 12
    })
    geometry.rotateX(-Math.PI / 2)
    const mesh = new T.Mesh(
      geometry,
      new T.MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.49 })
    )
    mesh.scale.setScalar(scale)
    mesh.position.set(x, 0.13, z)
    Object.assign(mesh.userData, action)
    this.group.add(mesh)
    if (op === 'XOR') {
      const a = pt(x - 0.56 * scale, 0.22, z - 0.33 * scale),
        b = pt(x - 0.34 * scale, 0.22, z),
        c = pt(x - 0.56 * scale, 0.22, z + 0.33 * scale)
      const arc = new T.Line(
        new T.BufferGeometry().setFromPoints(new T.QuadraticBezierCurve3(a, b, c).getPoints(14)),
        new T.LineBasicMaterial({ color: '#cedac5' })
      )
      this.group.add(arc)
    }
    if (op === 'NOT' || op === 'NAND') {
      const ring = new T.Mesh(
        new T.TorusGeometry(0.077 * scale, 0.027 * scale, 6, 16),
        new T.MeshBasicMaterial({ color: '#bfcfc4' })
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(x + 0.46 * scale, 0.23, z)
      this.group.add(ring)
    }
    this.print(key, x - 0.04 * scale, 0.16 + 0.24 * scale, z, 0.64 * scale, 0.32 * scale)
  }
  asset(eye: [number, number, number] = [0.28, 1.48, 1.22]): SceneAsset {
    return { group: this.group, labels: this.labels, routes: this.routes, eye }
  }
}

function lutView(s: Snapshot, loc: Location) {
  const width = families[s.family].width
  const size = 1 << (width / 2)
  const pitch = width === 6 ? 0.8 : 1.1
  const extent = (size - 1) * pitch
  const board = new Board(extent + 3.15, extent + 2.5)
  const lut = s.luts[loc.bit]
  const known = Boolean(lut)
  const address = lut?.address ?? 0
  const at: T.Vector3[][] = [[]]
  const name = (tier: number, index: number) => 'L' + loc.bit + (tier ? 'T' + tier + 'N' : 'M') + index
  for (let i = 0; i < size * size; i++) {
    const x = (i % size) * pitch - extent / 2,
      z = Math.floor(i / size) * pitch - extent / 2
    const target = { ...loc, level: 'gate' as const, tier: 1, muxIndex: i >> 1 }
    board.box(x, 0.17, z, pitch * 0.73, 0.2, pitch * 0.65, known && i === address ? lime : '#42665d', {
      jump: target
    })
    board.print(
      known ? String(lut.rows[0][i]) : '·',
      x,
      0.278,
      z,
      pitch * 0.54,
      pitch * 0.49,
      known && i === address ? '#24351e' : '#edf7eb'
    )
    at[0].push(pt(x, 0.3, z))
  }
  for (let tier = 1; tier <= width; tier++) {
    const row: T.Vector3[] = []
    for (let i = 0; i < at[tier - 1].length; i += 2) {
      const a = at[tier - 1][i],
        b = at[tier - 1][i + 1]
      const index = i / 2,
        selected = known && address >> tier === index
      const mid = a.clone().lerp(b, 0.5)
      mid.y += width === 6 ? 0.35 : 0.43
      const jump = { ...loc, level: 'gate' as const, tier, muxIndex: index }
      const g = board.box(mid.x, mid.y, mid.z, 0.31, 0.14, 0.25, selected ? lime : '#517f79', { jump })
      g.rotation.y = tier > width / 2 ? Math.PI * 0.5 : 0
      for (const [child, p] of [a, b].entries()) {
        board.wire(name(tier - 1, i + child), [p, mid])
      }
      row.push(mid)
    }
    at.push(row)
  }
  const end = at[width][0],
    output = pt(extent / 2 + 0.9, 0.43, 0)
  board.wire(name(width, 0), [end, pt(output.x, end.y, end.z), output])
  board.term(output.x, 0, 'OUT', name(width, 0))
  const chosen = at[0][address]
  board.tag(
    known ? '配置位 [' + address + ']' : '配置存储位',
    chosen.x,
    0.4,
    chosen.z,
    lime,
    10,
    known ? { signal: name(0, address) } : {}
  )
  board.tag('MUX × ' + (size * size - 1), end.x, end.y + 0.12, end.z, '#a9d4ce', 8, {
    jump: { ...loc, level: 'gate', tier: width, muxIndex: 0 }
  })
  board.print('LUT' + width, -extent / 2, 0.065, extent / 2 + 0.7, 1.2, 0.4)
  return board.asset([0.85, 1.22, 1.35])
}

export function buildUnit(s: Snapshot, loc: Location): SceneAsset {
  if (loc.unit === 'lut') return lutView(s, loc)
  const board = new Board(9.7, 4.5)
  const n = loc.bit,
    active = n < s.usedBits
  const jump = { ...loc, level: 'gate' as const }
  if (loc.unit === 'carry') {
    const start = loc.slice * families[s.family].lanes,
      count = families[s.family].lanes
    const span = 6.6,
      gap = span / count
    const ci = pt(-4.02, 0.31, 0.7),
      co = pt(4.02, 0.31, 0.7)
    const assigned = s.demo !== 'xor' && start < s.usedBits
    board.term(ci.x, ci.z, 'CIN', assigned ? 'C' + start : 'idleCin')
    board.term(co.x, co.z, 'COUT', assigned ? 'C' + (start + count) : 'idleCout')
    for (let i = 0; i < count; i++) {
      const lane = start + i,
        x = -span / 2 + gap * (i + 0.5),
        target = { ...jump, bit: lane }
      const live = lane < s.usedBits && s.demo !== 'xor'
      const local = (key: string) => (live ? key : 'unused-' + lane + key)
      board.gate(x, 0.7, 'MUX', 'MUX', n === lane ? gold : '#9f825a', { jump: target })
      board.gate(x, -0.75, 'XOR', 'XOR', jade, { jump: target })
      const left = i ? x - gap + 0.47 : ci.x + 0.45
      board.wire(local('C' + lane), [pt(left, 0.27, 0.7), pt(x - 0.46, 0.27, 0.7)])
      board.wire(local('C' + lane), [
        pt(x - 0.6, 0.27, 0.7),
        pt(x - 0.6, 0.27, -0.75),
        pt(x - 0.42, 0.27, -0.75)
      ])
      if (i === count - 1)
        board.wire(local('C' + (lane + 1)), [pt(x + 0.44, 0.27, 0.7), pt(co.x - 0.46, 0.27, 0.7)])
      const pPort = pt(x - 0.42, 0.25, -1.62),
        diPort = pt(x + 0.37, 0.25, 1.54)
      for (const p of [pPort, diPort]) board.box(p.x, p.y, p.z, 0.18, 0.1, 0.18, '#bcad85')
      board.wire(local('P' + lane), [
        pPort,
        pt(pPort.x, 0.25, -1.12),
        pt(x - 0.17, 0.25, -1.12),
        pt(x - 0.17, 0.25, -1.02)
      ])
      board.wire(local('P' + lane), [
        pt(pPort.x, 0.25, -1.12),
        pt(x - 0.58, 0.25, -1.12),
        pt(x - 0.58, 0.25, 0.18),
        pt(x, 0.25, 0.18),
        pt(x, 0.25, 0.36)
      ])
      board.wire(local('DI' + lane), [
        diPort,
        pt(x + 0.37, 0.25, 1.16),
        pt(x - 0.16, 0.25, 1.16),
        pt(x - 0.16, 0.25, 1.02)
      ])
      board.print('P', pPort.x, 0.07, pPort.z - 0.23, 0.27, 0.17)
      board.print('DI', diPort.x, 0.07, diPort.z + 0.23, 0.35, 0.17)
      const port = pt(x + 0.36, 0.25, -1.62)
      board.wire(local('S' + lane), [
        pt(x + 0.43, 0.27, -0.75),
        pt(x + 0.55, 0.27, -0.75),
        pt(x + 0.55, 0.25, port.z),
        port
      ])
      board.tag('位 ' + lane, x, 0.53, -0.75, '#c3ddbb', lane === n ? 9 : 3, {
        jump: target,
        signal: local('S' + lane)
      })
    }
    board.print(families[s.family].carry, 0, 0.063, 1.62, 1.65, 0.36)
  } else if (loc.unit === 'ff') {
    const live = active && s.demo === 'counter' && !loc.secondaryFF
    const sig = (name: string) => (live ? name : 'unused-' + name)
    board.term(-4, 0.1, 'D', sig('D' + n))
    board.term(4, 0.1, 'Q', sig('Q' + n))
    board.box(-2.42, 0.35, 0.1, 1.25, 0.44, 1.05, '#5b7d77', { jump })
    board.print('CE / SR', -2.42, 0.58, 0.1, 1.05, 0.46)
    for (const [i, x] of [-0.65, 1.55].entries()) {
      board.box(x, 0.4, 0.1, 1.48, 0.58, 1.28, i ? '#806f9e' : '#606687', { jump })
      board.print(i ? 'SLAVE' : 'MASTER', x, 0.7, 0.1, 1.2, 0.43)
      board.tag(i ? '从锁存器' : '主锁存器', x, 0.76, 0.1, lilac, 7, {
        jump,
        signal: sig((i ? 'Q' : 'M') + n)
      })
    }
    for (const [x1, x2, key] of [
      [-3.51, -3.05, 'D'],
      [-1.79, -1.39, 'E'],
      [0.09, 0.81, 'M'],
      [2.29, 3.51, 'Q']
    ] as const) {
      board.wire(sig(key + n), [pt(x1, 0.27, 0.1), pt(x2, 0.27, 0.1)])
    }
    board.term(-0.65, 1.63, 'CLK', sig('CLK'))
    board.wire(sig('CLK'), [pt(-0.65, 0.27, 1.35), pt(-0.65, 0.27, 0.75)])
    board.wire(sig('CLK'), [pt(-0.65, 0.27, 1.15), pt(1.55, 0.27, 1.15), pt(1.55, 0.27, 0.75)])
  } else {
    board.term(-3.65, -1, 'I0', 'wide0')
    board.term(-3.65, 1, 'I1', 'wide1')
    board.term(3.65, 0, 'O', 'wideY')
    board.gate(0, 0, 'MUX', 'MUX', jade, { jump }, 2.35)
    for (const [i, z] of [-1, 1].entries())
      board.wire('wide' + i, [
        pt(-3.16, 0.27, z),
        pt(-1.6, 0.27, z),
        pt(-1.6, 0.27, z * 0.55),
        pt(-1.02, 0.27, z * 0.55)
      ])
    board.wire('wideY', [pt(0.93, 0.27, 0), pt(3.16, 0.27, 0)])
    board.tag(loc.muxName ? loc.muxName + ' MUX' : '宽函数 MUX', 0, 0.91, 0, lime, 9, { jump })
  }
  return board.asset()
}

function clearsGates(path: T.Vector3[], obstacles: T.Box3[]) {
  const ray = new T.Ray(),
    hit = new T.Vector3()
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i],
      distance = a.distanceToSquared(b)
    if (distance < 1e-10) continue
    ray.origin.copy(a)
    ray.direction.subVectors(b, a).normalize()
    if (obstacles.some((box) => ray.intersectBox(box, hit) && hit.distanceToSquared(a) <= distance))
      return false
  }
  return true
}
export function buildGates(graph: GateGraph): SceneAsset {
  const xs = graph.nodes.map((n) => Math.abs(n.x)),
    zs = graph.nodes.map((n) => Math.abs(n.z))
  const board = new Board(Math.max(...xs) * 2 + 1.9, Math.max(...zs) * 2 + 2)
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const footprints = new Map(
    graph.nodes.map((n) => [
      n.id,
      new T.Box3(pt(n.x - 0.57, 0, n.z - 0.43), pt(n.x + 0.57, 0.8, n.z + 0.43))
    ])
  )
  for (const node of graph.nodes) {
    if (node.op === 'IN' || node.op === 'OUT') board.term(node.x, node.z, node.name, node.id)
    else {
      board.gate(
        node.x,
        node.z,
        node.op,
        node.op,
        node.op === 'NAND' ? lilac : node.op === 'XOR' ? gold : jade,
        { probe: node.id, signal: node.id }
      )
      board.tag(node.name, node.x, 0.49, node.z, '#bdd6ca', 3, { signal: node.id, probe: node.id })
    }
    node.inputs.forEach((id, pin) => {
      const src = nodes.get(id)!
      const x1 = src.x + 0.49,
        x2 = node.x - 0.49
      const z2 = node.z + (pin - (node.inputs.length - 1) / 2) * 0.3
      const y = 0.18 + pin * 0.045
      const start = pt(x1, y, src.z),
        end = pt(x2, y, z2)
      let points: T.Vector3[] = []
      if (x2 <= x1) {
        const gap = 0.55 + pin * 0.18
        const detour = src.z <= node.z ? Math.max(src.z, node.z) + gap : Math.min(src.z, node.z) - gap
        points = [
          start,
          pt(x1 + 0.19, y, src.z),
          pt(x1 + 0.19, y, detour),
          pt(x2 - 0.19, y, detour),
          pt(x2 - 0.19, y, z2),
          end
        ]
      } else {
        const obstacles = [...footprints]
          .filter(([key]) => key !== src.id && key !== node.id)
          .map(([, box]) => box)
        const candidates = [
          [start, end],
          [start, pt(x1, y, z2), end],
          [start, pt(x2, y, src.z), end]
        ]
        for (const fraction of [0.38 + 0.18 * pin, 0.18, 0.82]) {
          const turn = x1 + (x2 - x1) * fraction
          candidates.push([start, pt(turn, y, src.z), pt(turn, y, z2), end])
        }
        points = candidates.find((path) => clearsGates(path, obstacles)) ?? candidates[3]
      }
      board.wire(id, points)
    })
  }
  return board.asset([0.13, 1.74, 1.04])
}
