import { bit, mux, xor, type Snapshot } from './simulator.ts'
import type { Location } from '../scene/types.ts'

export type Op = 'IN' | 'OUT' | 'NOT' | 'AND' | 'OR' | 'XOR' | 'NAND' | 'MUX'
export interface GateNode {
  id: string
  name: string
  op: Op
  inputs: string[]
  x: number
  z: number
}
export interface GateGraph {
  nodes: GateNode[]
  values: Record<string, number | undefined>
  probes: GateNode[]
  title: string
}
export function gateGraph(s: Snapshot, loc: Location): GateGraph {
  const nodes: GateNode[] = []
  const values: GateGraph['values'] = {}
  const lane = loc.bit
  const active = lane < s.usedBits
  const v = (key: string) => (active ? s.values[key] : undefined)
  const input = (id: string, name: string, x: number, z: number, value?: number) => {
    nodes.push({ id, name, op: 'IN', inputs: [], x, z })
    values[id] = value
  }
  const gate = (id: string, name: string, op: Op, sources: string[], x: number, z: number) => {
    nodes.push({ id, name, op, inputs: sources, x, z })
    const args = sources.map((key) => values[key])
    if (args.some((val) => val === undefined)) return
    const [a, b, c] = args as number[]
    switch (op) {
      case 'NOT':
        values[id] = 1 ^ a
        break
      case 'AND':
        values[id] = a & b
        break
      case 'OR':
        values[id] = a | b
        break
      case 'XOR':
        values[id] = xor(a, b)
        break
      case 'NAND':
        values[id] = 1 ^ (a & b)
        break
      case 'MUX':
        values[id] = mux(a, b, c)
        break
      default:
        values[id] = a
    }
  }
  let title: string
  if (loc.unit === 'carry') {
    title = '单比特加法与进位选择'
    const live = s.demo !== 'xor'
    input('ga', 'A' + lane, -4.8, -1.4, live ? v('A' + lane) : undefined)
    input('gb', 'B' + lane, -4.8, 0.1, live ? v('B' + lane) : undefined)
    input('gc', 'C' + lane, -4.8, 1.7, live ? v('C' + lane) : undefined)
    gate('gp', 'P', 'XOR', ['ga', 'gb'], -2.65, -0.8)
    let di = 'ga'
    if (s.family === 'ecp5') {
      di = 'ggen'
      gate(di, 'G', 'AND', ['ga', 'gb'], -2.65, -2.05)
    }
    gate('gs', '和位', 'XOR', ['gp', 'gc'], 0.05, 2)
    gate('gn', '反相 P', 'NOT', ['gp'], -0.6, -1.95)
    gate('glu', '选 DI', 'AND', ['gn', di], 1.1, -1.55)
    gate('ghi', '选进位', 'AND', ['gp', 'gc'], 1.1, 0.15)
    gate('gco', '进位', 'OR', ['glu', 'ghi'], 3, -0.6)
    gate('cout', 'C' + (lane + 1), 'OUT', ['gco'], 4.7, -0.6)
    gate('sum', 'S' + lane, 'OUT', ['gs'], 4.7, 2)
  } else if (loc.unit === 'ff') {
    title = 'D 触发器 · 主从锁存'
    const running = active && s.demo === 'counter' && !loc.secondaryFF
    const q = running ? v('Q' + lane) : undefined
    const m = running ? v('M' + lane) : undefined
    const inv = (n: number | undefined) => (n === undefined ? undefined : 1 ^ n)
    // Feedback values survive while their cross-coupled NAND pair is closed.
    Object.assign(values, { gm: m, gmb: inv(m), gq: q, gqb: inv(q) })
    input('gd', '有效 D', -5.65, -1.35, running ? v('E' + lane) : undefined)
    input('gclk', 'CLK', -5.65, 1.55, running ? v('CLK') : undefined)
    gate('gdn', '反相 D', 'NOT', ['gd'], -3.98, -1.9)
    gate('gcn', '反相 CLK', 'NOT', ['gclk'], -3.98, 0.95)
    gate('gms', '主 S̅', 'NAND', ['gd', 'gcn'], -2.35, -1.2)
    gate('gmr', '主 R̅', 'NAND', ['gdn', 'gcn'], -2.35, 0.65)
    gate('gm', '主 M', 'NAND', ['gms', 'gmb'], -0.55, -1.2)
    gate('gmb', '主 M̅', 'NAND', ['gmr', 'gm'], -0.55, 0.65)
    gate('gss', '从 S̅', 'NAND', ['gm', 'gclk'], 1.25, -1.2)
    gate('gsr', '从 R̅', 'NAND', ['gmb', 'gclk'], 1.25, 0.65)
    gate('gq', '从 Q', 'NAND', ['gss', 'gqb'], 3.15, -1.2)
    gate('gqb', '从 Q̅', 'NAND', ['gsr', 'gq'], 3.15, 0.65)
    gate('out', 'Q' + lane, 'OUT', ['gq'], 5, -1.2)
  } else {
    title = loc.unit === 'lut' ? 'LUT 内部 · 二选一选择器' : '宽函数选择器 · 二选一'
    const lut = loc.unit === 'lut' ? s.luts[lane] : undefined
    const tier = Math.min(Math.max(1, loc.tier ?? 1), (lut?.rows.length ?? 2) - 1)
    const index = loc.muxIndex ?? (lut?.address ?? 0) >> tier
    input('gl', 'I0', -3.8, -1.5, lut?.rows[tier - 1]?.[index * 2])
    input('gsel', 'SEL', -3.8, 0, lut ? bit(lut.address, tier - 1) : undefined)
    input('gh', 'I1', -3.8, 1.5, lut?.rows[tier - 1]?.[index * 2 + 1])
    gate('gnot', '反相 SEL', 'NOT', ['gsel'], -1.95, -0.35)
    gate('glo', '低路', 'AND', ['gl', 'gnot'], -0.2, -1.25)
    gate('ghigh', '高路', 'AND', ['gh', 'gsel'], -0.2, 1.25)
    gate('gor', '合并', 'OR', ['glo', 'ghigh'], 1.85, 0)
    gate('out', 'Y', 'OUT', ['gor'], 3.7, 0)
  }
  return { nodes, values, title, probes: nodes.filter((n) => n.op !== 'IN' && n.op !== 'OUT') }
}
