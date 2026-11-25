import * as THREE from 'three'
import type { Demo, Family, SceneAsset, SceneLabel, SceneRoute } from './types.ts'

const columns = 11
const rows = 9
const pitchX = 0.66
const pitchZ = 0.6
const xOf = (column: number) => (column - (columns - 1) / 2) * pitchX
const zOf = (row: number) => (row - (rows - 1) / 2) * pitchZ
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

type XYZ = [number, number, number]
type Finish = 'ceramic' | 'aluminum' | 'gold' | 'tile' | 'logic' | 'selected' | 'mark'
interface Part {
  at: XYZ
  size: XYZ
  color: number
}

// A single draw per finish keeps the thousands of pads and etched details inexpensive.
class Parts {
  batches = new Map<Finish, Part[]>()

  add(finish: Finish, color: number, at: XYZ, size: XYZ) {
    const list = this.batches.get(finish)
    if (list) list.push({ at, size, color })
    else this.batches.set(finish, [{ at, size, color }])
  }

  mount(root: THREE.Group) {
    const geometry = new THREE.BoxGeometry()
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    const color = new THREE.Color()
    for (const [finish, list] of this.batches) {
      const metalness = finish === 'gold' ? 0.54 : finish === 'aluminum' ? 0.48 : 0.16
      const material =
        finish === 'mark'
          ? new THREE.MeshBasicMaterial({ color: 0xffffff })
          : new THREE.MeshStandardMaterial({
              color: 0xffffff,
              metalness,
              roughness: finish === 'gold' ? 0.34 : 0.52
            })
      const mesh = new THREE.InstancedMesh(geometry, material, list.length)
      mesh.name = '芯片 / ' + finish
      if (finish === 'logic' || finish === 'selected') mesh.userData.logicTile = true
      if (finish === 'selected') mesh.userData.watch = ['P0', 'P1', 'P2', 'P3', 'Q']
      for (let i = 0; i < list.length; i++) {
        const part = list[i]
        matrix.compose(position.fromArray(part.at), rotation, scale.fromArray(part.size))
        mesh.setMatrixAt(i, matrix)
        mesh.setColorAt(i, color.setHex(part.color))
      }
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.receiveShadow = true
      root.add(mesh)
    }
  }
}

function corners(width: number, depth: number, cut: number): THREE.Vector2[] {
  const w = width / 2
  const d = depth / 2
  return [
    [-w + cut, -d],
    [w - cut, -d],
    [w, -d + cut],
    [w, d - cut],
    [w - cut, d],
    [-w + cut, d],
    [-w, d - cut],
    [-w, -d + cut]
  ].map(([x, z]) => new THREE.Vector2(x, z))
}

function layer(
  root: THREE.Group,
  width: number,
  depth: number,
  cut: number,
  bottom: number,
  height: number,
  color: number,
  metalness: number,
  rim = 0
) {
  const path = new THREE.Shape(corners(width, depth, cut))
  if (rim)
    path.holes.push(
      new THREE.Path(corners(width - rim * 2, depth - rim * 2, Math.max(0.03, cut - rim * 0.45)).reverse())
    )
  const bevel = Math.min(0.025, height / 4)
  const geometry = new THREE.ExtrudeGeometry(path, {
    depth: height,
    steps: 1,
    bevelSegments: 1,
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel
  })
  geometry.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.42 })
  )
  mesh.position.y = bottom
  mesh.receiveShadow = true
  root.add(mesh)
}

function packageBody(group: THREE.Group, parts: Parts) {
  layer(group, 8.91, 7.15, 0.28, -0.3, 0.18, 0x202c31, 0.23)
  layer(group, 8.98, 7.22, 0.27, -0.11, 0.035, 0x987644, 0.46)
  layer(group, 8.96, 7.2, 0.27, -0.06, 0.13, 0x243b39, 0.25)
  layer(group, 8.85, 7.1, 0.26, 0.08, 0.125, 0x343e43, 0.35)
  layer(group, 8.34, 6.55, 0.16, 0.202, 0.11, 0x546266, 0.48, 0.16)
  layer(group, 7.94, 6.17, 0.12, 0.205, 0.08, 0x1d2b30, 0.25)

  // Plated perimeter leads with an outer toe, web and inner shoulder.
  for (const longEdge of [true, false]) {
    const count = longEdge ? 32 : 25
    const edge = longEdge ? 3.55 : 4.43
    const span = longEdge ? 7.86 : 6.09
    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        const along = (i / (count - 1) - 0.5) * span
        const place = (
          radial: number,
          y: number,
          length: number,
          width: number,
          height: number,
          color: number
        ) => {
          const across = side * (edge + radial)
          parts.add(
            'gold',
            color,
            longEdge ? [along, y, across] : [across, y, along],
            longEdge ? [width, height, length] : [length, height, width]
          )
        }
        place(0.12, -0.06, 0.3, 0.115, 0.07, 0xb49460)
        place(0.24, -0.135, 0.07, 0.118, 0.16, 0xbd9e68)
        place(0.33, -0.2, 0.22, 0.12, 0.055, 0xe0c08b)
        place(-0.14, 0.221, 0.17, 0.078, 0.023, 0xb5a47e)
      }
    }
  }

  // The I/O ring is distinct from the logic array. Each pad has a short metal fan-out.
  for (const xEdge of [true, false]) {
    const count = xEdge ? 20 : 27
    const span = xEdge ? 5.3 : 7.35
    const radius = xEdge ? 3.88 : 2.975
    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        const lane = (i / (count - 1) - 0.5) * span
        const radiusAt = side * radius
        const at: XYZ = xEdge ? [radiusAt, 0.31, lane] : [lane, 0.31, radiusAt]
        parts.add(
          'tile',
          i % 5 === 0 ? 0x718785 : 0x4c6566,
          at,
          xEdge ? [0.14, 0.088, 0.17] : [0.17, 0.088, 0.14]
        )
        const terminal = side * (radius + 0.045)
        parts.add(
          'gold',
          0xcbb286,
          xEdge ? [terminal, 0.367, lane] : [lane, 0.367, terminal],
          xEdge ? [0.058, 0.022, 0.095] : [0.095, 0.022, 0.058]
        )
        const trace = side * (radius - 0.075)
        parts.add(
          'aluminum',
          0x7b8984,
          xEdge ? [trace, 0.304, lane] : [lane, 0.304, trace],
          xEdge ? [0.22, 0.015, 0.018] : [0.018, 0.015, 0.22]
        )
      }
    }
  }

  const dot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.073, 0.073, 0.012, 18),
    new THREE.MeshStandardMaterial({ color: 0xd5cba7, metalness: 0.32, roughness: 0.45 })
  )
  dot.position.set(-4.14, 0.229, 3.26)
  group.add(dot)
}

function routingFabric(parts: Parts) {
  for (let i = 0; i <= columns; i++) {
    const x = xOf(i) - pitchX / 2
    for (const dx of [-0.026, 0.018]) {
      parts.add('aluminum', dx > 0 ? 0x647c79 : 0x465859, [x + dx, 0.299, 0], [0.012, 0.014, 5.6])
    }
  }
  for (let j = 0; j <= rows; j++) {
    const z = zOf(j) - pitchZ / 2
    for (const dz of [-0.022, 0.022]) {
      parts.add('aluminum', dz > 0 ? 0x78827e : 0x4c5e60, [0, 0.3, z + dz], [7.5, 0.014, 0.012])
    }
    for (let i = 0; i <= columns; i++) {
      parts.add('ceramic', 0x667978, [xOf(i) - pitchX / 2, 0.312, z], [0.07, 0.018, 0.063])
    }
  }
}

const logicColors = [0x477868, 0x53836f, 0x508170, 0x608573, 0x548874]
const resourceColors = {
  ram: { body: 0x66537e, top: 0x9d83b8, line: 0xc2a3d5 },
  dsp: { body: 0x8b6841, top: 0xbc8e59, line: 0xe6bb79 }
}

function logicTile(parts: Parts, family: Family, c: number, r: number, selected: boolean) {
  const x = xOf(c),
    z = zOf(r)
  const lift = selected ? 0.19 : 0
  const main = selected ? 'selected' : 'logic'
  const top = selected ? 0xc6e978 : logicColors[(c * 7 + r * 3) % logicColors.length]
  parts.add(main, 0x253b3a, [x, 0.329, z], [0.585, 0.065, 0.524])
  if (selected) {
    for (const dx of [-0.18, 0.18])
      for (const dz of [-0.15, 0.15]) {
        parts.add(main, 0x909f67, [x + dx, 0.432, z + dz], [0.062, 0.16, 0.062])
      }
  }
  parts.add(main, selected ? 0x738e43 : 0x38584d, [x, 0.395 + lift, z], [0.554, 0.118, 0.501])
  parts.add(main, top, [x, 0.463 + lift, z], [0.536, 0.041, 0.484])
  const slices = family === 'amd' ? 2 : 4
  const slicePitch = 0.47 / slices
  for (let s = 0; s < slices; s++) {
    const sx = x + (s - (slices - 1) / 2) * slicePitch
    parts.add(
      main,
      selected ? 0xd8f88f : 0x6c9583,
      [sx, 0.498 + lift, z - 0.025],
      [slicePitch * 0.84, 0.035, 0.326]
    )
    parts.add(
      main,
      selected ? 0x738b53 : 0x446958,
      [sx, 0.521 + lift, z - 0.071],
      [slicePitch * 0.55, 0.012, 0.017]
    )
    parts.add(
      main,
      selected ? 0x738b53 : 0x446958,
      [sx, 0.521 + lift, z + 0.011],
      [slicePitch * 0.55, 0.012, 0.017]
    )
  }
  if (selected) {
    for (const side of [-1, 1]) {
      parts.add('mark', 0xb4f96a, [x, 0.483 + lift, z + side * 0.275], [0.625, 0.023, 0.025])
      parts.add('mark', 0xb4f96a, [x + side * 0.303, 0.483 + lift, z], [0.025, 0.023, 0.545])
    }
  }
}

// Memory/DSP macros span two logic pitches. Their long axes follow the family's resource bands.
function macro(
  parts: Parts,
  kind: 'ram' | 'dsp',
  vertical: boolean,
  start: number,
  fixed: number,
  count: number
) {
  const c = vertical ? fixed : start + (count - 1) / 2
  const r = vertical ? start + (count - 1) / 2 : fixed
  const x = xOf(c),
    z = zOf(r)
  const width = vertical ? 0.55 : count * pitchX - 0.11
  const depth = vertical ? count * pitchZ - 0.105 : 0.505
  const tint = resourceColors[kind]
  parts.add('tile', 0x2b333a, [x, 0.337, z], [width + 0.027, 0.08, depth + 0.023])
  parts.add('tile', tint.body, [x, 0.43, z], [width, 0.157, depth])
  parts.add('tile', tint.top, [x, 0.52, z], [width - 0.04, 0.035, depth - 0.04])
  const ridges = kind === 'ram' ? count * 4 : count * 3
  for (let k = 0; k < ridges; k++) {
    const offset = (k / (ridges - 1) - 0.5) * ((vertical ? depth : width) - 0.2)
    parts.add(
      'tile',
      k % 3 === 0 ? tint.line : tint.body,
      [vertical ? x : x + offset, 0.545, vertical ? z + offset : z],
      vertical ? [width * 0.63, 0.012, 0.028] : [0.028, 0.012, depth * 0.63]
    )
  }
}

function clockSpine(parts: Parts, family: Family) {
  const x = family === 'amd' ? xOf(5) : xOf(5) + pitchX / 2
  parts.add('tile', 0x446983, [x, 0.326, 0], [family === 'amd' ? 0.105 : 0.041, 0.044, 5.47])
  if (family === 'amd') {
    for (let r = 0; r < rows; r++) {
      const z = zOf(r)
      parts.add('tile', 0x3e5d69, [x, 0.359, z], [0.44, 0.104, 0.47])
      parts.add('tile', 0x648b9e, [x, 0.436, z], [0.33, 0.055, 0.32])
      parts.add('aluminum', 0x92afba, [x, 0.472, z], [0.042, 0.02, 0.24])
    }
  }
  for (const side of [-1, 1]) {
    parts.add('tile', 0x3a566e, [side * 3.73, 0.35, -2.7], [0.38, 0.114, 0.29])
    parts.add('tile', 0x82a5bc, [side * 3.73, 0.427, -2.7], [0.28, 0.038, 0.19])
  }
}

function portsAndRoutes(parts: Parts, demo: Demo, x: number, z: number): SceneRoute[] {
  const track = 0.354
  const inputPort = v(x - 0.287, 0.631, z - 0.09)
  const secondPort = v(x + 0.287, 0.631, z - 0.14)
  const outputPort = v(x + 0.15, 0.633, z + 0.26)
  for (const port of [inputPort, secondPort, outputPort]) {
    parts.add('gold', 0xd9bd77, port.toArray(), [0.06, 0.056, 0.062])
  }

  const leftI = v(-3.9, 0.379, z - pitchZ / 2)
  const backI = v(x + pitchX / 2, 0.379, -2.99)
  const rightO = v(3.9, 0.379, z + pitchZ / 2)
  const clk = v(-3.73, 0.453, -2.7)
  for (const port of demo === 'counter' ? [rightO] : [leftI, backI, rightO]) {
    parts.add('gold', 0xe1cb89, port.toArray(), [0.089, 0.043, 0.092])
  }
  const leftX = x - pitchX / 2
  const rightX = x + pitchX / 2
  const backZ = z - pitchZ / 2
  const frontZ = z + pitchZ / 2
  const fromLeft = [
    leftI,
    v(leftX, track, backZ),
    v(leftX, track, inputPort.z),
    v(leftX, inputPort.y, inputPort.z),
    inputPort
  ]
  const fromBack = [
    backI,
    v(rightX, track, secondPort.z),
    v(rightX, secondPort.y, secondPort.z),
    secondPort
  ]
  const toRight = [
    outputPort,
    v(outputPort.x, outputPort.y, frontZ),
    v(outputPort.x, track, frontZ),
    rightO
  ]
  if (demo === 'counter') {
    return [
      { signal: 'CLK', points: [clk, v(leftX, track, clk.z), ...fromLeft.slice(1)] },
      {
        signal: 'D',
        points: [
          secondPort,
          v(rightX, secondPort.y, secondPort.z),
          v(rightX, track, secondPort.z),
          v(rightX, track, backZ),
          v(leftX, track, backZ),
          ...fromLeft.slice(2)
        ]
      },
      { signal: 'Q', points: toRight }
    ]
  }
  return [
    { signal: 'A', points: fromLeft },
    { signal: 'B', points: fromBack },
    { signal: demo === 'adder' ? 'SUM' : 'Y', points: toRight }
  ]
}

/** Open-package architectural cutaway. Macro positions and proportions are illustrative. */
export function buildChip(family: Family, demo: Demo): SceneAsset {
  const group = new THREE.Group()
  group.name = family === 'amd' ? 'AMD 7 系列芯片剖面' : 'Lattice ECP5 芯片剖面'
  const parts = new Parts()
  packageBody(group, parts)
  routingFabric(parts)
  clockSpine(parts, family)
  const vertical = family === 'amd'
  const ramBand = 2
  const dspBand = vertical ? 8 : 6
  const selectedCol = 4
  const selectedRow = vertical ? 5 : 4
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const band = vertical ? c : r
      if (band === ramBand || band === dspBand || (vertical && c === 5)) continue
      logicTile(parts, family, c, r, c === selectedCol && r === selectedRow)
    }
  }
  const span = vertical ? rows : columns
  for (let i = 0; i < span; i += 2) {
    const count = Math.min(2, span - i)
    macro(parts, 'ram', vertical, i, ramBand, count)
    macro(parts, 'dsp', vertical, i, dspBand, count)
  }
  const sx = xOf(selectedCol),
    sz = zOf(selectedRow)
  const routes = portsAndRoutes(parts, demo, sx, sz)
  parts.mount(group)
  const labels: SceneLabel[] = [
    {
      text: vertical ? 'CLB' : 'PFU',
      at: v(sx, 0.79, sz),
      color: '#c3f871',
      jump: { level: 'block' },
      watch: ['P0', 'P1', 'P2', 'P3', 'Q', 'D'],
      priority: 10
    },
    {
      text: vertical ? 'BRAM' : 'EBR',
      at: vertical ? v(xOf(ramBand), 0.59, zOf(1)) : v(xOf(1), 0.59, zOf(ramBand)),
      color: '#ceb1ee',
      priority: 5
    },
    {
      text: 'DSP',
      at: vertical ? v(xOf(dspBand), 0.59, zOf(3)) : v(xOf(8), 0.59, zOf(dspBand)),
      color: '#edbd81',
      priority: 4
    },
    { text: 'I/O', at: v(-3.88, 0.39, 1.84), color: '#c3d4ce', priority: 2 }
  ]
  return { group, labels, routes, eye: [0.82, 1.25, 1.4] }
}
