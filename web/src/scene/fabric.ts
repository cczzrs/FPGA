import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Shape,
  SRGBColorSpace,
  Vector3
} from 'three'
import { sampleBlock } from '../logic/hierarchy.ts'
import type { Demo, Family, Jump, Location, SceneAsset, SceneLabel, SceneRoute, Unit } from './types.ts'

type Point = [number, number, number]

const finish = {
  base: '#222b33',
  rim: '#54626d',
  face: '#334245',
  inset: '#1b282c',
  seam: '#597172',
  metal: '#9fadb1',
  contact: '#c0a576',
  trace: '#688882',
  logic: '#368875',
  logicDim: '#39665d',
  lime: '#bded79',
  memory: '#74b49b',
  mux: '#477c85',
  muxCap: '#8fc9cb',
  carry: '#a27642',
  gold: '#efbb71',
  ff: '#69658e',
  ffCap: '#b2a7df',
  clock: '#80aac9',
  ink: '#151e23'
} as const
type Finish = keyof typeof finish

const vec = (p: Point) => new Vector3(...p)
const up = new Vector3(0, 1, 0)
const origin = new Quaternion()
const textTint = '#d6e3de'
const widthOf = (family: Family) => (family === 'amd' ? 4 : 2)
const sliceName = (family: Family, n: number) =>
  family === 'amd' ? (n === 0 ? 'SLICEM' : 'SLICEL') : `SLICE ${n}`

interface Batch {
  shape: 'box' | 'round'
  color: Finish
  jump?: Jump
  matrices: Matrix4[]
}
interface Inscription {
  text: string
  center: Point
  width: number
  height: number
  jump?: Jump
}

/** All dimensions and route anchors use the same board coordinate system. */
class Drawing {
  readonly group = new Group()
  readonly routes: SceneRoute[] = []
  readonly labels: SceneLabel[] = []
  private batches = new Map<string, Batch>()
  private materials = new Map<Finish, MeshStandardMaterial>()
  private inscriptions: Inscription[] = []

  private material(key: Finish) {
    let mat = this.materials.get(key)
    if (!mat) {
      const c = new Color(finish[key])
      const isMetal = ['metal', 'contact', 'rim', 'gold'].includes(key)
      mat = new MeshStandardMaterial({
        color: c,
        roughness: isMetal ? 0.41 : 0.64,
        metalness: isMetal ? 0.38 : 0.17,
        emissive: c,
        emissiveIntensity: key === 'lime' ? 0.43 : 0.12
      })
      this.materials.set(key, mat)
    }
    return mat
  }

  private stamp(
    shape: Batch['shape'],
    color: Finish,
    pos: Vector3,
    size: Vector3,
    rot: Quaternion,
    jump?: Jump
  ) {
    const key = [
      shape,
      color,
      jump?.level,
      jump?.slice,
      jump?.unit,
      jump?.bit,
      jump?.secondaryFF,
      jump?.muxName
    ].join('/')
    let batch = this.batches.get(key)
    if (!batch) {
      batch = { shape, color, jump, matrices: [] }
      this.batches.set(key, batch)
    }
    batch.matrices.push(new Matrix4().compose(pos, rot, size))
  }

  box(pos: Point, size: Point, color: Finish, jump?: Jump) {
    this.stamp('box', color, vec(pos), vec(size), origin, jump)
  }

  post(x: number, y: number, z: number, diameter: number, height: number, color: Finish, jump?: Jump) {
    this.stamp('round', color, new Vector3(x, y, z), new Vector3(diameter, height, diameter), origin, jump)
  }

  line(points: Point[], color: Finish, thickness = 0.026, jump?: Jump) {
    for (let i = 1; i < points.length; i++) {
      const a = vec(points[i - 1]),
        b = vec(points[i])
      const axis = b.clone().sub(a)
      const length = axis.length()
      if (length < 0.001) continue
      const rot = new Quaternion().setFromUnitVectors(up, axis.normalize())
      this.stamp('box', color, a.lerp(b, 0.5), new Vector3(thickness, length, thickness), rot, jump)
    }
  }

  wire(signal: string | undefined, points: Point[], color: Finish = 'trace') {
    if (!signal) this.line(points, color, 0.02)
    if (signal) this.routes.push({ signal, points: points.map(vec) })
  }

  solid(
    cx: number,
    y: number,
    cz: number,
    polygon: [number, number][],
    height: number,
    color: Finish,
    jump?: Jump
  ) {
    const shape = new Shape()
    polygon.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)))
    shape.closePath()
    const bevel = Math.min(0.045, height / 5)
    const geometry = new ExtrudeGeometry(shape, {
      depth: height - 2 * bevel,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 1,
      curveSegments: 1,
      steps: 1
    })
    geometry.rotateX(-Math.PI / 2)
    const obj = new Mesh(geometry, this.material(color))
    obj.position.set(cx, y + bevel, cz)
    if (jump) obj.userData.jump = jump
    this.group.add(obj)
  }

  plate(x: number, y: number, z: number, w: number, d: number, h: number, color: Finish, jump?: Jump) {
    const a = w / 2,
      b = d / 2,
      cut = Math.min(0.22, d * 0.12, w * 0.12)
    this.solid(
      x,
      y,
      z,
      [
        [-a + cut, -b],
        [a - cut, -b],
        [a, -b + cut],
        [a, b - cut],
        [a - cut, b],
        [-a + cut, b],
        [-a, b - cut],
        [-a, -b + cut]
      ],
      h,
      color,
      jump
    )
  }

  corners(x: number, y: number, z: number, w: number, d: number, color: Finish, jump?: Jump) {
    const length = Math.min(0.34, w / 4, d / 4)
    for (const dx of [-1, 1])
      for (const dz of [-1, 1]) {
        const xx = x + (dx * w) / 2,
          zz = z + (dz * d) / 2
        this.line(
          [
            [xx - dx * length, y, zz],
            [xx, y, zz],
            [xx, y, zz - dz * length]
          ],
          color,
          0.046,
          jump
        )
      }
  }

  port(x: number, y: number, z: number, color: Finish = 'contact', jump?: Jump) {
    this.post(x, y - 0.015, z, 0.19, 0.07, 'ink', jump)
    this.post(x, y + 0.02, z, 0.12, 0.048, color, jump)
  }

  label(text: string, pos: Point, color: string, priority: number, jump?: Jump, signal?: string) {
    this.labels.push({ text, at: vec(pos), color, priority, jump, signal })
  }

  print(text: string, center: Point, width: number, height: number, jump?: Jump) {
    this.inscriptions.push({ text, center, width, height, jump })
  }

  private addSilk() {
    if (typeof document === 'undefined' || this.inscriptions.length === 0) return
    const canvas = document.createElement('canvas')
    const cellW = 256,
      cellH = 48,
      cols = 4
    const rows = Math.ceil(this.inscriptions.length / cols)
    canvas.width = cellW * cols
    canvas.height = cellH * rows
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#e0eae3'
    ctx.font = '600 31px "IBM Plex Mono", monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    texture.minFilter = LinearFilter
    const mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: DoubleSide
    })
    this.inscriptions.forEach(({ text, center, width, height, jump }, i) => {
      const col = i % cols,
        row = Math.floor(i / cols)
      ctx.fillText(text, (col + 0.5) * cellW, (row + 0.51) * cellH, cellW - 12)
      const realWidth = Math.min(width, (height * ctx.measureText(text).width) / cellH)
      const pixelWidth = Math.min(cellW - 4, ctx.measureText(text).width + 5)
      const mid = (col + 0.5) / cols
      const left = mid - pixelWidth / (2 * canvas.width),
        right = mid + pixelWidth / (2 * canvas.width)
      const top = 1 - row / rows,
        bottom = 1 - (row + 1) / rows
      const [x, y, z] = center,
        a = realWidth / 2,
        b = height / 2
      const g = new BufferGeometry()
      g.setAttribute(
        'position',
        new Float32BufferAttribute([x - a, y, z + b, x + a, y, z + b, x + a, y, z - b, x - a, y, z - b], 3)
      )
      g.setAttribute(
        'uv',
        new Float32BufferAttribute([left, bottom, right, bottom, right, top, left, top], 2)
      )
      g.setIndex([0, 1, 2, 0, 2, 3])
      const mesh = new Mesh(g, mat)
      if (jump) mesh.userData.jump = jump
      this.group.add(mesh)
    })
    texture.needsUpdate = true
  }

  complete(eye: [number, number, number]): SceneAsset {
    const box = new BoxGeometry(1, 1, 1),
      round = new CylinderGeometry(0.5, 0.5, 1, 14)
    for (const batch of this.batches.values()) {
      const mesh = new InstancedMesh(
        batch.shape === 'round' ? round : box,
        this.material(batch.color),
        batch.matrices.length
      )
      batch.matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      if (batch.jump) mesh.userData.jump = batch.jump
      this.group.add(mesh)
    }
    this.addSilk()
    return { group: this.group, routes: this.routes, labels: this.labels, eye }
  }
}

function substrate(board: Drawing, w: number, d: number, name: string) {
  board.plate(0, 0, 0, w, d, 0.27, 'base')
  board.plate(0, 0.27, 0, w - 0.18, d - 0.18, 0.1, 'rim')
  board.plate(0, 0.37, 0, w - 0.31, d - 0.31, 0.18, 'face')
  const x = w / 2 - 0.47,
    z = d / 2 - 0.47
  for (const dx of [-x, x])
    for (const dz of [-z, z]) {
      board.post(dx, 0.57, dz, 0.27, 0.09, 'metal')
      board.line(
        [
          [dx - 0.068, 0.619, dz + 0.033],
          [dx + 0.068, 0.619, dz - 0.033]
        ],
        'ink',
        0.033
      )
    }
  for (let i = 0; i < Math.floor((w - 1.8) / 0.37); i++) {
    const xx = -w / 2 + 1.05 + i * 0.37
    board.box([xx, 0.552, -d / 2 + 0.35], [0.045, 0.016, i % 4 === 0 ? 0.17 : 0.09], 'seam')
  }
  board.print(name, [0, 0.563, d / 2 - 0.38], Math.min(5, w - 2), 0.29)
}

function compactSlice(
  board: Drawing,
  family: Family,
  demo: Demo,
  n: number,
  cx: number,
  cz: number,
  w: number,
  d: number,
  selected: boolean,
  used: boolean
) {
  const rows = widthOf(family)
  const jump: Jump = { level: 'slice', slice: n, bit: n * rows, unit: 'lut' }
  board.plate(cx, 0.58, cz, w, d, 0.18, 'inset', jump)
  board.plate(cx, 0.77, cz, w - 0.14, d - 0.14, 0.14, used ? 'logicDim' : 'face', jump)
  board.corners(cx, 0.932, cz, w - 0.27, d - 0.27, selected ? 'lime' : 'seam', jump)
  const xLut = cx - w * 0.185,
    xFf = cx + w * 0.26,
    xCarry = cx + w * 0.086
  const spacing = (d - 1.28) / rows
  const watch: string[] = []
  for (let i = 0; i < rows; i++) {
    const zz = cz + (rows / 2 - i - 0.5) * spacing - 0.17
    board.box([xLut, 1.015, zz], [w * 0.35, 0.17, spacing * 0.7], used ? 'logic' : 'logicDim', jump)
    for (let k = 0; k < 4; k++) {
      board.box(
        [xLut + w * (k - 1.5) * 0.066, 1.106, zz],
        [w * 0.035, 0.018, spacing * 0.49],
        'memory',
        jump
      )
    }
    board.box([xCarry, 0.995, zz], [w * 0.1, 0.13, spacing * 0.55], 'carry', jump)
    board.box([xFf, 1.006, zz], [w * 0.15, 0.15, spacing * 0.25], 'ff', jump)
    if (family === 'amd')
      board.box([xFf, 1.006, zz + spacing * 0.27], [w * 0.15, 0.15, spacing * 0.19], 'ff', jump)
    const lane = n * rows + i
    if (!used || (demo === 'xor' && lane !== 0))
      board.line(
        [
          [xLut + w * 0.18, 0.948, zz],
          [xFf, 0.948, zz]
        ],
        'trace',
        0.03,
        jump
      )
    if (used && (demo !== 'xor' || lane === 0)) {
      const y = 1.025,
        portX = cx + w * 0.225,
        terminalZ = cz + d / 2 - 0.19
      if (demo === 'xor') {
        board.wire('P0', [
          [xLut + w * 0.175, y, zz],
          [xLut + w * 0.21, y, zz],
          [xLut + w * 0.21, y, terminalZ - 0.16],
          [portX, y, terminalZ - 0.16],
          [portX, 0.978, terminalZ]
        ])
        watch.push('P0')
      } else {
        board.wire('P' + lane, [
          [xLut + w * 0.175, y, zz],
          [xCarry - w * 0.05, y, zz]
        ])
        board.wire(
          'C' + (lane + 1),
          [
            [xCarry, y, zz - spacing * 0.27],
            [xCarry, y, zz - spacing * 0.72]
          ],
          'carry'
        )
        const outX = demo === 'counter' ? xFf - w * 0.078 : portX
        board.wire(demo === 'counter' ? 'D' + lane : 'S' + lane, [
          [xCarry + w * 0.05, y, zz],
          [outX, y, zz]
        ])
        watch.push('S' + lane)
      }
    }
  }
  board.print(sliceName(family, n), [cx, 0.922, cz + d / 2 - 0.43], w - 0.54, 0.35, jump)
  board.label(
    family === 'amd' ? `Slice ${n} · ${sliceName(family, n)}` : `Slice ${n}`,
    [cx, 1.14, cz - 0.27],
    selected ? finish.lime : textTint,
    selected ? 8 : 4,
    jump
  )
  board.labels[board.labels.length - 1].watch = watch
}

export function buildBlock(family: Family, demo: Demo, loc: Location): SceneAsset {
  const board = new Drawing(),
    amd = family === 'amd'
  const count = amd ? 2 : 4,
    tileW = amd ? 4.55 : 2.82,
    tileD = amd ? 4.74 : 4.3
  substrate(board, amd ? 13.25 : 14.65, 8.7, amd ? 'CLB / 7 SERIES' : 'PFU / ECP5')
  const xs = amd ? [-2.4, 2.68] : [-4.89, -1.63, 1.63, 4.89]
  const zs = amd ? [0.04, -0.56] : [-0.45, -0.45, -0.45, -0.45]
  const occupied = !loc.block || loc.block === sampleBlock(family)
  const pathCount = occupied ? (demo === 'xor' || amd ? 1 : 2) : 0
  const routingZ = 3.08
  board.plate(0, 0.58, routingZ, amd ? 10.8 : 12.5, 0.79, 0.16, 'inset')
  board.print('SWITCH MATRIX', [-4.25, 0.755, routingZ], 1.7, 0.2)
  for (let i = 0; i < count; i++) {
    const x = xs[i],
      z = zs[i],
      used = i < pathCount
    compactSlice(board, family, demo, i, x, z, tileW, tileD, loc.slice === i, used)
    const edgeZ = z + tileD / 2,
      start = i * widthOf(family)
    const pair = (bus: string) => (amd ? bus : bus + '[' + (start + 1) + ':' + start + ']')
    const signals =
      demo === 'xor'
        ? ['A', 'B', 'Y']
        : demo === 'adder'
          ? [pair('A'), pair('B'), pair('SUM')]
          : ['CLK', 'EN', pair('Q')]
    const terminalColors: Finish[] =
      demo === 'counter' ? ['clock', 'contact', 'ffCap'] : ['contact', 'contact', 'lime']
    for (let pin = 0; pin < 3; pin++) {
      const px = x + (pin - 1) * tileW * 0.225,
        terminalZ = edgeZ - 0.19
      board.port(px, 0.795, routingZ, terminalColors[pin])
      board.port(px, 0.96, terminalZ, terminalColors[pin], { level: 'slice', slice: i, bit: start })
      const points: Point[] = [
        [px, 0.815, routingZ],
        [px, 0.815, edgeZ + 0.13],
        [px, 0.978, edgeZ],
        [px, 0.978, terminalZ]
      ]
      if (pin === 2) points.reverse()
      board.wire(used ? signals[pin] : undefined, points)
    }
  }
  if (!amd) {
    for (let i = 0; i < 3; i++) {
      const x0 = xs[i] + tileW / 2 - 0.1,
        x1 = xs[i + 1] - tileW / 2 + 0.1,
        z = zs[i] - 0.75
      board.port(x0, 0.964, z, 'gold')
      board.port(x1, 0.964, z, 'gold')
      board.wire(
        occupied && demo !== 'xor' && i === 0 ? 'C2' : undefined,
        [
          [x0, 0.982, z],
          [x1, 0.982, z]
        ],
        'carry'
      )
      if (occupied && demo !== 'xor' && i === 0)
        board.label('跨 Slice 进位', [(x0 + x1) / 2, 1.13, z - 0.16], finish.gold, 9, undefined, 'C2')
    }
  }
  return board.complete([0.46, 1.19, 1.35])
}

function lutTile(
  board: Drawing,
  x: number,
  z: number,
  family: Family,
  lane: number,
  jump: Jump,
  used: boolean
) {
  const n = family === 'amd' ? 8 : 4
  board.plate(x, 0.58, z, 2.02, 1.18, 0.33, used ? 'logic' : 'logicDim', jump)
  board.box([x - 0.27, 0.917, z], [1.16, 0.035, 0.83], 'inset', jump)
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) {
      const xx = x - 0.27 + ((col + 0.5 - n / 2) * 1.05) / n,
        zz = z + ((row + 0.5 - n / 2) * 0.73) / n
      board.box([xx, 0.948, zz], [0.75 / n, 0.036, 0.48 / n], 'memory', jump)
    }
  const tag = family === 'amd' ? `${'ABCD'[lane]}6` : `F${lane}`
  board.print(tag, [x + 0.64, 0.924, z], 0.53, 0.3, jump)
  board.corners(x, 0.925, z, 1.85, 1.02, used ? 'lime' : 'seam', jump)
}

const lutX = -3.04,
  carryX = 1.1,
  ffX = 3.33,
  inputX = -5.65,
  outputX = 5.62
const dataHeight = 0.654
const lanePoint = (x: number, z: number): Point => [x, dataHeight, z]

function wideMuxes(board: Drawing, family: Family, lanes: number[], base: number, slice: number) {
  const addMux = (x: number, z: number, word: string, bit: number) => {
    const jump: Jump = { level: 'unit', unit: 'mux', slice, bit, muxName: word }
    board.solid(
      x,
      0.6,
      z,
      [
        [-0.36, -0.37],
        [0.37, -0.2],
        [0.37, 0.2],
        [-0.36, 0.37]
      ],
      0.21,
      'mux',
      jump
    )
    board.print(word, [x, 0.821, z], 0.62, 0.22, jump)
    return jump
  }
  const localX = -1.05
  const pairZ = (a: number, b: number) => (lanes[a] + lanes[b]) / 2
  const pairs =
    family === 'amd'
      ? [
          [0, 1],
          [2, 3]
        ]
      : [[0, 1]]
  for (const [a, b] of pairs) {
    const z = pairZ(a, b)
    const j = addMux(localX, z, family === 'amd' ? (a === 0 ? 'F7A' : 'F7B') : 'LUT5', base + a)
    for (const [lane, side] of [
      [a, 1],
      [b, -1]
    ]) {
      const track = -1.79 + side * 0.07
      board.wire(
        undefined,
        [
          lanePoint(lutX + 1.0, lanes[lane] + side * 0.2),
          lanePoint(track, lanes[lane] + side * 0.2),
          lanePoint(track, z + side * 0.16),
          lanePoint(localX - 0.34, z + side * 0.16)
        ],
        'seam'
      )
    }
    if (a === 0)
      board.label(family === 'amd' ? 'F7A MUX' : 'LUT5 MUX', [localX, 0.86, z], finish.muxCap, 2, j)
  }
  const z = family === 'amd' ? 0 : lanes[1] - 0.97
  const root = addMux(-0.23, z, family === 'amd' ? 'F8' : 'FX', base)
  if (family === 'amd') {
    for (const k of [0, 2]) {
      const sign = k === 0 ? 1 : -1,
        fromZ = pairZ(k, k + 1)
      board.wire(
        undefined,
        [
          lanePoint(localX + 0.35, fromZ),
          lanePoint(-0.52, fromZ),
          lanePoint(-0.52, z + sign * 0.15),
          lanePoint(-0.49, z + sign * 0.15)
        ],
        'seam'
      )
    }
  } else {
    // FXA and FXB belong to the wider, inter-slice expansion network.
    for (const side of [-1, 1]) {
      const pinX = -1.35 + side * 0.17
      board.port(pinX, 0.6, z - 0.16 + side * 0.14, 'muxCap')
      board.wire(
        undefined,
        [lanePoint(pinX, z - 0.16 + side * 0.14), lanePoint(-0.58, z + side * 0.13)],
        'seam'
      )
    }
  }
  board.label(family === 'amd' ? 'F8 MUX' : 'FX MUX', [-0.22, 0.85, z], finish.muxCap, 1, root)
}

function registerTile(board: Drawing, z: number, amd: boolean, jump: Jump, lane: number) {
  const names = amd ? [`${'ABCD'[lane]}FF`, `${'ABCD'[lane]}5FF`] : [`FF${lane}`]
  names.forEach((name, i) => {
    const zz = z + i * 0.49
    const target = { ...jump, secondaryFF: i === 1 }
    board.plate(ffX, 0.6, zz, 1.29, 0.43, 0.26, 'ff', target)
    board.print(name, [ffX + 0.02, 0.874, zz], 0.87, 0.25, target)
    board.box([ffX - 0.49, 0.875, zz], [0.08, 0.024, 0.24], 'ffCap', target)
  })
}

export function buildSlice(family: Family, demo: Demo, loc: Location): SceneAsset {
  const board = new Drawing(),
    amd = family === 'amd',
    n = widthOf(family)
  const base = loc.slice * n,
    d = amd ? 9.5 : 7.7
  const lanes = amd ? [2.55, 0.85, -0.85, -2.55] : [1.22, -1.22]
  const active = (bit: number) =>
    (!loc.block || loc.block === sampleBlock(family)) && (demo === 'xor' ? bit === 0 : bit < 4)
  substrate(board, 13.05, d, `${sliceName(family, loc.slice)} / ${amd ? '7 SERIES' : 'ECP5'}`)
  const front = lanes[0] + 0.8,
    back = lanes.at(-1)! - 0.8
  board.plate(carryX, 0.565, (front + back) / 2, 1.47, front - back, 0.07, 'inset')
  wideMuxes(board, family, lanes, base, loc.slice)
  for (let i = 0; i < n; i++) {
    const z = lanes[i],
      bit = base + i,
      used = active(bit),
      arithmetic = used && demo !== 'xor',
      counter = used && demo === 'counter'
    const jump = (unit: Unit): Jump => ({ level: 'unit', slice: loc.slice, unit, bit })
    lutTile(board, lutX, z, family, i, jump('lut'), used)
    registerTile(board, z, amd, jump('ff'), i)
    board.plate(carryX, 0.65, z, 1.16, 0.82, 0.24, 'carry', jump('carry'))
    board.print(`C${i}`, [carryX, 0.905, z], 0.66, 0.26, jump('carry'))
    const from = i === 0 ? front : lanes[i - 1] - 0.41
    board.wire(
      arithmetic ? `C${bit}` : undefined,
      [lanePoint(carryX, from), lanePoint(carryX, z + 0.41)],
      'carry'
    )
    if (i === n - 1)
      board.wire(
        arithmetic ? `C${bit + 1}` : undefined,
        [lanePoint(carryX, z - 0.41), lanePoint(carryX, back)],
        'carry'
      )
    const a = used ? (counter ? `Q${bit}` : demo === 'xor' ? 'A' : `A${bit}`) : undefined
    const b = used && !counter ? (demo === 'xor' ? 'B' : `B${bit}`) : undefined
    for (const [s, offset] of [
      [a, -0.2],
      [b, 0.2]
    ] as const) {
      board.port(inputX, 0.61, z + offset, used ? 'contact' : 'seam')
      board.wire(s, [lanePoint(inputX, z + offset), lanePoint(lutX - 1.02, z + offset)])
    }
    board.wire(arithmetic ? `P${bit}` : undefined, [lanePoint(lutX + 1.01, z), lanePoint(carryX - 0.6, z)])
    // LUT bypass goes around the arithmetic unit and both storage elements.
    const bypassZ = z - 0.6
    board.wire(
      used && demo === 'xor' ? 'Y' : undefined,
      [
        lanePoint(lutX + 1.0, z - 0.1),
        lanePoint(-1.85, z - 0.1),
        lanePoint(-1.85, bypassZ),
        lanePoint(outputX, bypassZ),
        lanePoint(outputX, z - 0.21)
      ],
      'seam'
    )
    board.port(outputX, 0.61, z - 0.21, used ? 'contact' : 'seam')
    const result = arithmetic ? (counter ? `D${bit}` : `S${bit}`) : undefined
    if (counter) {
      board.wire(result, [lanePoint(carryX + 0.58, z), lanePoint(ffX - 0.66, z)])
    } else {
      board.wire(result, [
        lanePoint(carryX + 0.58, z),
        lanePoint(2.15, z),
        lanePoint(2.15, z - 0.39),
        lanePoint(outputX - 0.26, z - 0.39),
        lanePoint(outputX - 0.26, z - 0.21),
        lanePoint(outputX, z - 0.21)
      ])
    }
    board.port(outputX, 0.61, z + 0.19, counter ? 'ffCap' : 'seam')
    board.wire(
      counter ? `Q${bit}` : undefined,
      [
        lanePoint(ffX + 0.65, z),
        lanePoint(4.66, z),
        lanePoint(4.66, z + 0.19),
        lanePoint(outputX, z + 0.19)
      ],
      'trace'
    )
    const focus = i === Math.max(0, loc.bit - base) % n
    if (focus) {
      board.label(
        amd ? `LUT6 · ${'ABCD'[i]}` : `LUT4 · ${i}`,
        [lutX, 1.05, z - 0.03],
        finish.lime,
        9,
        jump('lut')
      )
      board.label(amd ? 'CARRY4' : 'CCU2', [carryX, 1.02, z], finish.gold, 8, jump('carry'))
      board.label(amd ? `${'ABCD'[i]}FF` : `FF${i}`, [ffX, 1.0, z], finish.ffCap, 7, jump('ff'))
      if (used && demo === 'xor')
        board.label('输出 Y', [outputX, 0.78, z - 0.21], finish.lime, 6, undefined, 'Y')
      if (arithmetic)
        board.label(
          counter ? '寄存器 Q' : '和位 S',
          [outputX, 0.78, z + (counter ? 0.19 : -0.21)],
          counter ? finish.ffCap : finish.lime,
          5,
          undefined,
          counter ? `Q${bit}` : `S${bit}`
        )
    }
  }
  board.port(carryX, 0.67, front, 'gold')
  board.port(carryX, 0.67, back, 'gold')
  board.print(amd ? 'CYINIT / CIN' : 'FCI', [carryX + 0.74, 0.563, front + 0.14], 1.49, 0.24)
  board.print(amd ? 'COUT' : 'FCO', [carryX + 0.53, 0.563, back - 0.21], 1.04, 0.23)
  // A slice distributes clock, enable and reset to the row registers.
  const controls = ['CLK', 'EN', 'RST'] as const
  for (const [j, signal] of controls.entries()) {
    const x = 4.18 + j * 0.19,
      headZ = d / 2 - 0.92
    board.port(x, 0.615, headZ, signal === 'CLK' ? 'clock' : 'contact')
    let previous = headZ
    for (const [i, z] of lanes.entries()) {
      const zz = z + 0.14 - j * 0.13
      const s = demo === 'counter' && active(base + i) ? signal : undefined
      board.wire(s, [lanePoint(x, previous), lanePoint(x, zz)], 'seam')
      board.wire(s, [lanePoint(x, zz), lanePoint(ffX + 0.65, zz)], 'seam')
      previous = zz
    }
  }
  board.print('CLK / CE / SR', [4.28, 0.564, d / 2 - 0.6], 2.0, 0.24)
  return board.complete([0.26, 1.33, 1.16])
}
