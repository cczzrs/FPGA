import { Builder, type Bit, type Design, type Module } from '../src/model/cells.ts'

/** 只用一个模块内部的门，按端口值算出它的所有输出。 */
export function evaluateModule(design: Design, module: Module, inputs: Record<string, Bit>): Record<string, Bit> {
  const known = new Map<number, Bit>()
  for (const p of module.ports) if (p.dir === 'in' && p.name in inputs) known.set(p.net, inputs[p.name]!)
  const drivers = new Map<number, Module>()
  const collect = (m: Module): void => {
    if (m.kind === 'and' || m.kind === 'or' || m.kind === 'not') drivers.set(m.ports.at(-1)!.net, m)
    m.children.forEach(collect)
  }
  collect(module)
  const read = (id: number): Bit => {
    const value = known.get(id)
    if (value !== undefined) return value
    const gate = drivers.get(id)
    let result: Bit
    if (!gate) {
      const constant = design.nets[id]!.constant
      if (constant === undefined) throw new Error(`${module.id} 缺少输入 ${design.nets[id]!.name}`)
      result = constant
    } else {
      const a = read(gate.ports[0]!.net)
      result = gate.kind === 'not' ? ((1 - a) as Bit)
        : gate.kind === 'and' ? ((a & read(gate.ports[1]!.net)) as Bit)
        : ((a | read(gate.ports[1]!.net)) as Bit)
    }
    known.set(id, result)
    return result
  }
  return Object.fromEntries(module.ports.filter((p) => p.dir === 'out').map((p) => [p.name, read(p.net)]))
}

export function bench(build: (b: Builder) => Record<string, number[]>): Design {
  const b = new Builder('amd', 'xor')
  const probes = build(b)
  return b.finish(b.module(b.root, 'idle', 'block', '空'), probes)
}

export const bit = (value: number, i: number): Bit => ((value >> i) & 1) as Bit

export function adderInputs(a: number, b: number): Record<string, Bit> {
  const inputs: Record<string, Bit> = {}
  for (let i = 0; i < 4; i++) {
    inputs[`A${i}`] = bit(a, i)
    inputs[`B${i}`] = bit(b, i)
  }
  return inputs
}

export function word(values: Uint8Array, nets: number[]): number {
  return nets.reduce((sum, id, i) => sum + values[id]! * 2 ** i, 0)
}
