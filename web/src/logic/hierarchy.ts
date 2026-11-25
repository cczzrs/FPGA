import { gateGraph } from './gates.ts'
import { families, type Snapshot } from './simulator.ts'
import type { Family, Jump, Location, Unit } from '../scene/types.ts'

export interface ResourceNode {
  id: string
  label: string
  kind: string
  jump?: Jump
  inspect?: { kind: string; name: string; description: string; x?: number; z?: number }
  children?: () => ResourceNode[]
}

type Producer = () => ResourceNode[]
const list = <T>(count: number, make: (index: number) => T) =>
  Array.from({ length: count }, (_, index) => make(index))

function branch(id: string, label: string, kind: string, make: Producer, jump?: Jump): ResourceNode {
  let materialized: ResourceNode[] | undefined
  return { id, label, kind, jump, children: () => (materialized ??= make()) }
}

function inspect(
  id: string,
  name: string,
  kind: string,
  description: string,
  x: number,
  z: number
): ResourceNode {
  return { id, label: name, kind, inspect: { kind, name, description, x, z } }
}

// Dimensions of the illustrated architecture window, matching the top-level chip scene.
const columns = 11,
  rows = 9,
  pitchX = 0.66,
  pitchZ = 0.6
const xOf = (column: number) => (column - (columns - 1) / 2) * pitchX
const zOf = (row: number) => (row - (rows - 1) / 2) * pitchZ
const gridX = (column: number) => xOf(column) - pitchX / 2
const gridZ = (row: number) => zOf(row) - pitchZ / 2
const logicAt = (family: Family, col: number, row: number) =>
  family === 'amd' ? col !== 2 && col !== 5 && col !== 8 : row !== 2 && row !== 6
export const sampleBlock = (family: Family) => (family === 'amd' ? 'X4Y5' : 'X4Y4')
const gridBlock = (col: number, row: number) => `X${col}Y${row}`

function blockId(family: Family, ref: string) {
  if (ref === sampleBlock(family)) return 'chip/logic/' + ref
  return 'chip/logic/rows/Y' + ref.split('Y')[1] + '/' + ref
}

function muxNames(family: Family) {
  return family === 'amd' ? ['F7A', 'F7B', 'F8'] : ['LUT5', 'FX']
}

/** All ancestors of a node are the slash-delimited prefixes of its ID. */
export function resourceIdFor(family: Family, loc: Location, probe = loc.probe) {
  if (loc.level === 'chip') return 'chip'
  const block = blockId(family, loc.block ?? sampleBlock(family))
  if (loc.level === 'block') return block
  const slice = block + '/S' + loc.slice
  if (loc.level === 'slice') return slice
  const lane = loc.bit % families[family].lanes
  let unit: string
  switch (loc.unit) {
    case 'lut':
      unit = slice + '/lut' + lane
      break
    case 'ff':
      unit = slice + '/ff' + lane + (loc.secondaryFF ? 'aux' : '')
      break
    case 'mux':
      unit = slice + '/mux-' + (loc.muxName ?? muxNames(family)[0])
      break
    case 'carry':
      unit = slice + '/carry'
      break
  }
  if (loc.level === 'unit') return unit
  let circuit: string
  if (loc.unit === 'lut') circuit = unit + '/mux/T' + (loc.tier ?? 1) + '/N' + (loc.muxIndex ?? 0)
  else if (loc.unit === 'carry') circuit = unit + '/bit' + lane
  else circuit = unit + '/gates'
  return probe ? circuit + '/' + probe : circuit
}

interface Probe {
  id: string
  label: string
}
const probeCache = new Map<string, Probe[]>()
function gateProbes(family: Family, unit: Unit) {
  const key = family + '/' + unit
  let template = probeCache.get(key)
  if (!template) {
    // The schematic owns gate IDs and connectivity. An unassigned lane asks for topology only.
    const snapshot: Snapshot = { family, demo: 'xor', values: {}, luts: [], usedBits: 0, phases: [] }
    template = gateGraph(snapshot, { level: 'gate', slice: 0, bit: 0, unit }).probes.map((node) => ({
      id: node.id,
      label: node.op + ' · ' + node.name
    }))
    probeCache.set(key, template)
  }
  return template
}

function gateCircuit(id: string, label: string, kind: string, family: Family, where: Location) {
  return branch(
    id,
    label,
    kind,
    () =>
      gateProbes(family, where.unit).map((probe) => ({
        id: id + '/' + probe.id,
        label: probe.label,
        kind: 'gate',
        jump: { ...where, probe: probe.id }
      })),
    where
  )
}

function lutChildren(id: string, family: Family, where: Location) {
  const width = families[family].width
  const count = 1 << width
  const side = 1 << (width / 2)
  const config = id + '/config',
    mux = id + '/mux'
  return [
    branch(config, `配置存储位 · ${count} 位`, 'config-bank', () =>
      list(side, (row) => {
        const rowId = config + '/row' + row
        const first = row * side
        return branch(rowId, `M[${first}–${first + side - 1}]`, 'config-row', () =>
          list(side, (col) => {
            const addr = first + col
            return {
              id: rowId + '/M' + addr,
              label: `M[${addr}] · ${addr.toString(2).padStart(width, '0')}`,
              kind: 'config-bit',
              jump: {
                ...where,
                level: 'gate',
                tier: 1,
                muxIndex: addr >> 1,
                probe: addr % 2 ? 'ghigh' : 'glo'
              }
            }
          })
        )
      })
    ),
    branch(mux, `查表选择器树 · ${count - 1} 个 MUX`, 'lut-network', () =>
      list(width, (level) => {
        const tier = level + 1,
          tierId = mux + '/T' + tier,
          size = count >> tier
        return branch(tierId, `第 ${tier} 层 · I${level} · ${size} 个 MUX`, 'mux-layer', () =>
          list(size, (index) =>
            gateCircuit(tierId + '/N' + index, `MUX[${index}]`, 'lut-mux', family, {
              ...where,
              level: 'gate',
              tier,
              muxIndex: index
            })
          )
        )
      })
    )
  ]
}

function sliceUnits(family: Family, block: string, slice: number, id: string) {
  const spec = families[family],
    base = slice * spec.lanes
  const location = (unit: Unit, lane = 0): Location => ({
    level: 'unit',
    slice,
    bit: base + lane,
    block,
    unit
  })
  const nodes = list(spec.lanes, (lane) => {
    const unit = id + '/lut' + lane
    const loc = location('lut', lane)
    const label = `LUT${spec.width} · ${family === 'amd' ? 'ABCD'[lane] : 'F' + lane}`
    return branch(unit, label, 'lut', () => lutChildren(unit, family, loc), loc)
  })
  for (let lane = 0; lane < spec.lanes; lane++) {
    const kinds = family === 'amd' ? [false, true] : [false]
    for (const aux of kinds) {
      const unit = id + '/ff' + lane + (aux ? 'aux' : '')
      const name = family === 'amd' ? 'ABCD'[lane] + (aux ? '5FF' : 'FF') : 'FF' + lane
      const loc = { ...location('ff', lane), secondaryFF: aux }
      nodes.push(
        branch(
          unit,
          name + (aux ? ' · 辅助触发器' : ' · 触发器'),
          'ff',
          () => [
            gateCircuit(unit + '/gates', '主从锁存等效门', 'gate-circuit', family, {
              ...loc,
              level: 'gate'
            })
          ],
          loc
        )
      )
    }
  }
  for (const name of muxNames(family)) {
    const unit = id + '/mux-' + name
    const loc = { ...location('mux', name === 'F7B' ? 2 : 0), muxName: name }
    nodes.push(
      branch(
        unit,
        name + ' MUX',
        'mux',
        () => [
          gateCircuit(unit + '/gates', '二选一等效门', 'gate-circuit', family, { ...loc, level: 'gate' })
        ],
        loc
      )
    )
  }
  const carry = id + '/carry'
  nodes.push(
    branch(
      carry,
      spec.carry + ' · 专用进位链',
      'carry',
      () =>
        list(spec.lanes, (lane) =>
          gateCircuit(
            carry + '/bit' + lane,
            `第 ${lane} 级 · C${base + lane} → C${base + lane + 1}`,
            'carry-stage',
            family,
            { ...location('carry', lane), level: 'gate' }
          )
        ),
      location('carry')
    )
  )
  return nodes
}

function logicBlock(family: Family, block: string): ResourceNode {
  const spec = families[family],
    id = blockId(family, block)
  const label = spec.block + ' ' + block + (block === sampleBlock(family) ? ' · 示例电路' : '')
  return branch(
    id,
    label,
    'block',
    () =>
      list(spec.slices, (slice) => {
        const name =
          'Slice ' + slice + (family === 'amd' ? ' · ' + (slice === 0 ? 'SLICEM' : 'SLICEL') : '')
        const sliceId = id + '/S' + slice
        return branch(sliceId, name, 'slice', () => sliceUnits(family, block, slice, sliceId), {
          level: 'slice',
          block,
          slice,
          unit: 'lut',
          bit: slice * spec.lanes
        })
      }),
    { level: 'block', block, slice: 0, bit: 0, unit: 'lut' }
  )
}

function logicArray(family: Family) {
  const sample = sampleBlock(family)
  return branch('chip/logic', '逻辑阵列 · ' + families[family].block, 'logic-array', () => {
    const rowNodes: ResourceNode[] = []
    let otherSites = 0
    for (let row = 0; row < rows; row++) {
      const sites = list(columns, (col) => col).filter(
        (col) => logicAt(family, col, row) && gridBlock(col, row) !== sample
      )
      if (!sites.length) continue
      otherSites += sites.length
      rowNodes.push(
        branch('chip/logic/rows/Y' + row, `阵列行 Y${row} · ${sites.length} 个逻辑块`, 'array-row', () =>
          sites.map((col) => logicBlock(family, gridBlock(col, row)))
        )
      )
    }
    return [
      logicBlock(family, sample),
      branch(
        'chip/logic/rows',
        `其余 ${otherSites} 个 ${families[family].block} · 按行`,
        'array-rows',
        () => rowNodes
      )
    ]
  })
}

function macros(family: Family, kind: 'ram' | 'dsp') {
  const vertical = family === 'amd',
    end = vertical ? rows : columns
  const band = kind === 'ram' ? 2 : vertical ? 8 : 6
  const name = kind === 'ram' ? families[family].ram : 'DSP'
  const id = 'chip/' + kind
  return branch(id, name + (kind === 'ram' ? ' · 块存储器' : ' · 数字信号处理'), kind + '-group', () =>
    list(Math.ceil(end / 2), (index) => {
      const from = index * 2,
        to = Math.min(from + 1, end - 1),
        middle = (from + to) / 2
      const x = xOf(vertical ? band : middle),
        z = zOf(vertical ? middle : band)
      const span = from === to ? String(from) : from + '–' + to
      const range = vertical ? `X${band} / Y${span}` : `X${span} / Y${band}`
      return inspect(
        id + '/' + index,
        name + ' ' + index,
        kind,
        `${range}。本模型中的` +
          (kind === 'ram'
            ? '专用片上存储块，读写端口经互连连接到逻辑阵列。'
            : '专用算术块，提供硬件乘法和累加资源。'),
        x,
        z
      )
    })
  )
}

function clocks(family: Family) {
  const id = 'chip/clock',
    center = family === 'amd' ? xOf(5) : xOf(5) + pitchX / 2
  return branch(id, '时钟网络', 'clock-group', () => {
    const items = [inspect(id + '/spine', '时钟主干', 'clock', '沿芯片中心分发时钟的专用通路。', center, 0)]
    if (family === 'amd')
      items.push(
        branch(id + '/column', '时钟分配列', 'clock-column', () =>
          list(rows, (row) =>
            inspect(
              id + '/column/Y' + row,
              '分配节点 Y' + row,
              'clock',
              '时钟主干在本行的分配节点。',
              center,
              zOf(row)
            )
          )
        )
      )
    for (const [key, label, side] of [
      ['left', '左', -1],
      ['right', '右', 1]
    ] as const)
      items.push(
        inspect(
          id + '/' + key,
          label + '侧时钟模块',
          'clock',
          '芯片边缘的时钟资源，向片内时钟网络送入时钟。',
          side * 3.73,
          -2.7
        )
      )
    return items
  })
}

const edges = [
  { key: 'left', name: '左侧', onX: true, sign: -1 },
  { key: 'right', name: '右侧', onX: true, sign: 1 },
  { key: 'back', name: '后侧', onX: false, sign: -1 },
  { key: 'front', name: '前侧', onX: false, sign: 1 }
] as const

function io() {
  const id = 'chip/io'
  const sides = (physical: boolean) =>
    edges.map(({ key, name, onX, sign }) => {
      const count = physical ? (onX ? 25 : 32) : onX ? 20 : 27
      const radius = physical ? (onX ? 4.43 : 3.55) + 0.33 : onX ? 3.88 : 2.975
      const span = physical ? (onX ? 6.09 : 7.86) : onX ? 5.3 : 7.35
      const side = (physical ? id + '/pins' : id) + '/' + key,
        suffix = physical ? '引脚' : 'I/O 单元'
      return branch(side, name + suffix + ' · ' + count, 'io-side', () =>
        list(count, (index) => {
          const along = (index / (count - 1) - 0.5) * span,
            across = sign * radius
          return inspect(
            side + '/' + index,
            name + suffix + ' ' + index,
            physical ? 'pin' : 'io',
            physical
              ? '封装外缘的金属引线，编号用于定位本示意模型。'
              : '芯片 I/O 环上的输入输出单元，连接边缘缓冲与片内互连。',
            onX ? across : along,
            onX ? along : across
          )
        })
      )
    })
  return branch(id, 'I/O · 输入输出', 'io-group', () => [
    ...sides(false),
    branch(id + '/pins', '封装引脚', 'pin-group', () => sides(true))
  ])
}

function interconnect() {
  const id = 'chip/routing'
  const tracks = (vertical: boolean) => {
    const group = id + (vertical ? '/columns' : '/rows'),
      dir = vertical ? '纵向' : '横向',
      count = vertical ? columns + 1 : rows + 1
    return branch(group, dir + '布线通道', 'route-channels', () =>
      list(count, (n) => {
        const ch = group + '/' + n,
          name = dir + '通道 ' + n,
          mid = vertical ? gridX(n) : gridZ(n)
        return branch(ch, name, 'route-channel', () =>
          list(2, (lane) => {
            const delta = vertical ? [-0.026, 0.018][lane] : [-0.022, 0.022][lane]
            return inspect(
              ch + '/' + lane,
              name + ' · 线 ' + lane,
              'routing',
              '逻辑块之间的金属布线段，可通过连接点接入相邻通道。',
              vertical ? mid + delta : 0,
              vertical ? 0 : mid + delta
            )
          })
        )
      })
    )
  }
  return branch(id, '可编程互连', 'routing-group', () => [
    tracks(true),
    tracks(false),
    branch(id + '/switches', '路由交叉点', 'switch-grid', () =>
      list(rows + 1, (row) => {
        const rowId = id + '/switches/Y' + row
        return branch(rowId, '交叉点行 Y' + row, 'switch-row', () =>
          list(columns + 1, (col) =>
            inspect(
              rowId + '/X' + col,
              `交叉点 X${col}Y${row}`,
              'routing',
              '横纵布线通道的交叉位置，实际连接由路由配置选择。',
              gridX(col),
              gridZ(row)
            )
          )
        )
      })
    )
  ])
}

export function resourceTree(family: Family): ResourceNode {
  return branch(
    'chip',
    families[family].name,
    'chip',
    () => [
      logicArray(family),
      macros(family, 'ram'),
      macros(family, 'dsp'),
      clocks(family),
      io(),
      interconnect()
    ],
    { level: 'chip' }
  )
}
