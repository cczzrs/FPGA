import type { Bit, Design, Gate, Module, Port } from './cells.ts'
import { at, type Example } from './stages.ts'

export type Inputs = Record<string, Bit>
export type Registers = Record<string, Bit>
export type Shown = Bit | 'pending' | 'unused'

export interface Result {
  design: Design
  stage: number
  values: Uint8Array
}

function compute(gate: Gate, values: Uint8Array): Bit {
  const a = values[gate.inputs[0]!] as Bit
  if (gate.op === 'not') return (a ^ 1) as Bit
  const b = values[gate.inputs[1]!] as Bit
  return (gate.op === 'and' ? a & b : a | b) as Bit
}

/** 锁存状态固定时，让所有组合门传播一次。 */
export function propagate(design: Design, inputs: Inputs, regs: Registers): Uint8Array {
  const values = new Uint8Array(design.nets.length)
  for (const net of design.nets) {
    if (net.constant !== undefined) values[net.id] = net.constant
    else if (net.input !== undefined) {
      const value = inputs[net.input]
      if (value === undefined) throw new Error(`缺少输入 ${net.input}`)
      values[net.id] = value
    }
  }
  for (const latch of design.latches) {
    const q = (latch.key && regs[latch.key]) || 0
    values[latch.q] = q
    values[latch.qn] = q ^ 1
  }
  for (const gate of design.order) values[gate.out] = compute(gate, values)
  return values
}

/**
 * 每轮先用同一份快照求所有锁存的下一状态，再一起提交。
 * 主、从锁存的使能互补，所以新 Q 不会在一个时钟沿内穿回主锁存。
 */
export function settle(design: Design, inputs: Inputs, regs: Registers): Registers {
  if (!design.latches.length) return regs
  let state = regs
  for (let round = 0; round < 6; round++) {
    const snapshot = propagate(design, inputs, state)
    const next = { ...state }
    let changed = false
    for (const latch of design.latches) {
      const values = snapshot.slice()
      let stable = false
      for (let i = 0; i < 6 && !stable; i++) {
        stable = true
        for (const gate of latch.loop) {
          const value = compute(gate, values)
          if (values[gate.out] !== value) {
            values[gate.out] = value
            stable = false
          }
        }
      }
      if (!stable || values[latch.q] === values[latch.qn]) throw new Error(`锁存未收敛：${latch.key}`)
      if (!latch.key) throw new Error('使用中的锁存缺少状态键')
      if (values[latch.q] !== (state[latch.key] ?? 0)) changed = true
      next[latch.key] = values[latch.q] as Bit
    }
    if (!changed) return next
    state = next
  }
  throw new Error('时序电路未收敛')
}

const UPDATE = at('counter', 'update')
const READY = at('counter', 'ready')

export function revealed(example: Example, netStage: number, stage: number): boolean {
  if (netStage > stage) return false
  // Q 刚更新时，新值还没有传过组合逻辑。
  return !(example === 'counter' && stage === UPDATE && netStage >= 1 && netStage <= READY)
}

/** 三维、端口、表格和波形读值的唯一入口。 */
export function display(result: Result, id: number): Shown {
  const { design, stage, values } = result
  const net = design.nets[id]!
  if (!net.used) return 'unused'
  return revealed(design.example, net.at, stage) ? (values[id] as Bit) : 'pending'
}

/** 端口读值：同一根线上未被选用的端口显示为未使用。 */
export function displayPort(result: Result, port: Port): Shown {
  return port.used ? display(result, port.net) : 'unused'
}

export function readWord(result: Result, probe: string): number | null {
  let word = 0
  for (const [i, id] of result.design.probes[probe]!.entries()) {
    const value = display(result, id)
    if (value === 'pending' || value === 'unused') return null
    word += value * 2 ** i
  }
  return word
}

export interface Selection {
  address: number
  /** 选中分支上的模块，包含起点配置位。 */
  path: Set<Module>
}

/** 按引脚上的实际值找出 LUT 选中的配置位与分支。 */
export function selection(result: Result, lut: Module): Selection | null {
  const { design, stage, values } = result
  const pins = lut.ports.filter((p) => p.dir === 'in')
  const outputs = lut.ports.filter((p) => p.dir === 'out')
  const start = design.example === 'xor' ? at('xor', 'config') : lut.at
  if (!revealed(design.example, start, stage)) return null
  if (outputs.every((p) => !p.used)) return null
  if (pins.some((p) => typeof display(result, p.net) !== 'number')) return null

  const address = pins.reduce((sum, p, i) => sum + values[p.net]! * 2 ** i, 0)
  const keys = new Set<string>()
  const walk = (index: number, levels: number): void => {
    keys.add(`bit${index}`)
    for (let level = 0; level < levels; level++) keys.add(`m${level}_${index >> (level + 1)}`)
  }
  walk(address, pins.length)
  const tap = outputs[1]!
  // 引出的子树有独立负载时，同时显示第二条路径。
  if (tap.used) {
    const levels = pins.length === 6 ? 5 : 2
    walk(address % 2 ** levels, levels)
  }
  return { address, path: new Set(lut.children.filter((c) => keys.has(c.key))) }
}
