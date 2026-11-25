import { BITS, type Arch, type Example } from './stages.ts'

export type Bit = 0 | 1
export type Op = 'and' | 'or' | 'not'
export type Kind =
  | 'chip' | 'block' | 'slice'
  | 'lut' | 'carry4' | 'carrybit' | 'ccu' | 'ff' | 'latch'
  | 'mux' | 'xor' | 'adder' | 'select'
  | 'switch' | 'pad' | 'cfg'
  | Op

export interface Port {
  name: string
  dir: 'in' | 'out'
  net: number
  /** 本例是否真的经这个端口取值或送值。同一根线可以接着未选用的端口。 */
  used: boolean
}

export interface Module {
  id: string
  key: string
  kind: Kind
  name: string
  parent: Module | null
  children: Module[]
  ports: Port[]
  /** 本模块输出最早出现的阶段。 */
  at: number
  role?: string
  /** 只承担进位引入或引出的模块。 */
  aux?: boolean
  init?: bigint
  value?: Bit
}

export interface Net {
  id: number
  name: string
  at: number
  used: boolean
  constant?: Bit
  input?: string
}

export interface Gate {
  op: Op
  inputs: number[]
  out: number
  module: Module
  /** 配置已关断的输入：仍参与求值，但不算使用这一路资源。 */
  unselected?: number
}

export interface Latch {
  /** 与架构无关的状态键：m0–m3 为主锁存，s0–s3 为从锁存。 */
  key?: string
  q: number
  qn: number
  loop: Gate[]
}

export interface Route {
  type: 'in' | 'out' | 'feedback'
  src: number
  dst: number
  pad?: Module
  sb: Module
  cb?: Module
}

export interface Design {
  arch: Arch
  example: Example
  root: Module
  idle: Module
  modules: Map<string, Module>
  roles: Map<string, Module>
  nets: Net[]
  /** 按拓扑顺序排列，只含影响输出与观察点的门。 */
  order: Gate[]
  latches: Latch[]
  routes: Route[]
  probes: Record<string, number[]>
}

type Options = Pick<Partial<Module>, 'at' | 'role' | 'aux' | 'init' | 'value'>

export function port(module: Module, name: string): number {
  const found = module.ports.find((p) => p.name === name)
  if (!found) throw new Error(`${module.id} 没有端口 ${name}`)
  return found.net
}

export function child(module: Module, key: string): Module {
  const found = module.children.find((c) => c.key === key)
  if (!found) throw new Error(`${module.id} 没有子模块 ${key}`)
  return found
}

export function closest(module: Module | null, kind: Kind): Module | null {
  let current = module
  while (current && current.kind !== kind) current = current.parent
  return current
}

export class Builder {
  arch: Arch
  example: Example
  root: Module
  nets: Net[] = []
  gates: Gate[] = []
  latches: Latch[] = []
  routes: Route[] = []
  modules = new Map<string, Module>()
  roles = new Map<string, Module>()

  constructor(arch: Arch, example: Example) {
    this.arch = arch
    this.example = example
    this.root = this.module(null, 'chip', 'chip', '芯片总览')
  }

  module(parent: Module | null, key: string, kind: Kind, name: string, options: Options = {}): Module {
    const id = parent ? `${parent.id}/${key}` : key
    if (this.modules.has(id)) throw new Error(`模块重复：${id}`)
    const created: Module = { id, key, kind, name, parent, children: [], ports: [], at: parent?.at ?? 0, ...options }
    parent?.children.push(created)
    this.modules.set(id, created)
    if (created.role) this.roles.set(created.role, created)
    return created
  }

  net(name: string, extra: Pick<Partial<Net>, 'constant' | 'input'> = {}): number {
    const id = this.nets.length
    this.nets.push({ id, name, at: 0, used: false, ...extra })
    return id
  }

  constant(value: Bit, name = `常量 ${value}`): number {
    return this.net(name, { constant: value })
  }

  open(name = '未连接'): number {
    return this.constant(0, name)
  }

  input(module: Module, name: string, net: number): number {
    module.ports.push({ name, dir: 'in', net, used: false })
    return net
  }

  output(module: Module, name: string, net: number): number {
    module.ports.push({ name, dir: 'out', net, used: false })
    return net
  }

  gate(parent: Module, key: string, op: Op, inputs: number[], options: Options = {}, out?: number): number {
    const module = this.module(parent, key, op, op.toUpperCase(), options)
    inputs.forEach((net, i) => this.input(module, i ? 'B' : 'A', net))
    const y = this.output(module, 'Y', out ?? this.net(`${module.id}.Y`))
    this.gates.push({ op, inputs, out: y, module })
    return y
  }

  config(parent: Module, key: string, name: string, value: Bit): number {
    const module = this.module(parent, key, 'cfg', name, { value })
    return this.output(module, 'Q', this.constant(value, name))
  }

  mux(parent: Module, key: string, name: string, i0: number, i1: number, s: number, options: Options = {}): number {
    const m = this.module(parent, key, 'mux', name, options)
    this.input(m, 'I0', i0)
    this.input(m, 'I1', i1)
    this.input(m, 'S', s)
    const ns = this.gate(m, 'ns', 'not', [s])
    const low = this.gate(m, 'low', 'and', [i0, ns])
    const high = this.gate(m, 'high', 'and', [i1, s])
    return this.output(m, 'O', this.gate(m, 'or', 'or', [low, high]))
  }

  /** 标出一个门里被配置关断的输入。 */
  unselect(module: Module, net: number): void {
    const gate = this.gates.findLast((g) => g.module === module)!
    gate.unselected = net
  }

  /** 选择端固定为配置位的选择器。 */
  configuredMux(parent: Module, key: string, name: string, i0: number, i1: number, value: Bit, options: Options = {}): number {
    const s = this.config(parent, `${key}_select`, `${name} 配置`, value)
    const out = this.mux(parent, key, name, i0, i1, s, options)
    const mux = child(parent, key)
    this.unselect(child(mux, value ? 'low' : 'high'), value ? i0 : i1)
    return out
  }

  xor(parent: Module, key: string, name: string, a: number, b: number, options: Options = {}): number {
    const m = this.module(parent, key, 'xor', name, options)
    this.input(m, 'A', a)
    this.input(m, 'B', b)
    const na = this.gate(m, 'na', 'not', [a])
    const nb = this.gate(m, 'nb', 'not', [b])
    const left = this.gate(m, 'left', 'and', [a, nb])
    const right = this.gate(m, 'right', 'and', [na, b])
    return this.output(m, 'O', this.gate(m, 'or', 'or', [left, right]))
  }

  /** 已配置的单路选通，功能等效为“与配置位 1 相与”。 */
  select(parent: Module, key: string, name: string, pin: string, input: number, options: Options = {}, kind: Kind = 'select'): number {
    const m = this.module(parent, key, kind, name, options)
    this.input(m, pin, input)
    const enable = this.config(m, 'enable', '选通配置', 1)
    return this.output(m, 'O', this.gate(m, 'pass', 'and', [input, enable]))
  }

  /**
   * LUT = 配置位 + MUX 树。第一级由最低地址位选择。
   * tap 把第 n 级最低子树引出：LUT6 的 O5（n=5）、LUT4 中的 LUT2（n=2）。
   */
  lut(
    parent: Module, key: string, name: string, pins: [string, number][], init: bigint,
    outputs: { main: string; tap: string; level: number }, options: Options = {},
  ): { out: number; tap: number } {
    const m = this.module(parent, key, 'lut', name, { ...options, init })
    for (const [pin, net] of pins) this.input(m, pin, net)
    let row = Array.from({ length: 2 ** pins.length }, (_, i) =>
      this.config(m, `bit${i}`, `INIT[${i}]`, Number((init >> BigInt(i)) & 1n) as Bit))
    let tap = -1
    pins.forEach(([pin, select], level) => {
      const next: number[] = []
      for (let i = 0; i < row.length; i += 2) {
        next.push(this.mux(m, `m${level}_${i / 2}`, `MUX ${pin}`, row[i]!, row[i + 1]!, select))
      }
      row = next
      if (level + 1 === outputs.level) tap = row[0]!
    })
    this.output(m, outputs.main, row[0]!)
    this.output(m, outputs.tap, tap)
    return { out: row[0]!, tap }
  }

  /** 读取同一批线值的一位全加器等效图，不驱动硬件。 */
  adder(parent: Module, a: number, b: number, c: number, at: { p: number; s: number; c: number }): void {
    const m = this.module(parent, 'fa', 'adder', '一位全加器（功能等效）', { at: at.p })
    this.input(m, 'A', a)
    this.input(m, 'B', b)
    this.input(m, 'Cin', c)
    const p = this.xor(m, 'p', 'A ⊕ B', a, b)
    const sum = this.xor(m, 'sum', 'P ⊕ Cin', p, c, { at: at.s })
    const generate = this.gate(m, 'generate', 'and', [a, b], { at: at.c })
    const pass = this.gate(m, 'pass', 'and', [p, c], { at: at.c })
    this.output(m, 'Sum', sum)
    this.output(m, 'Cout', this.gate(m, 'carry', 'or', [generate, pass], { at: at.c }))
  }

  /** 清零优先于使能；两级门控 SR 锁存各含一对交叉反馈的或非门。 */
  flipFlop(
    parent: Module, key: string, name: string,
    pins: { d: number; ce: number; r: number; clk: number; q?: number },
    options: Options & { bit?: number; edge?: number },
  ): number {
    const { bit, edge, ...rest } = options
    const m = this.module(parent, key, 'ff', name, rest)
    const q = pins.q ?? this.net(`${m.id}.Q`)
    this.input(m, 'D', pins.d)
    this.input(m, 'CE', pins.ce)
    this.input(m, 'R', pins.r)
    this.input(m, 'C', pins.clk)
    const kept = this.mux(m, 'enable', '使能选择', q, pins.d, pins.ce)
    const nr = this.gate(m, 'nr', 'not', [pins.r])
    const next = this.gate(m, 'clear', 'and', [kept, nr])
    const nc = this.gate(m, 'nc', 'not', [pins.clk], { at: 0 })
    const master = this.latch(m, 'master', '主锁存', next, nc, {}, bit === undefined ? undefined : `m${bit}`)
    this.latch(m, 'slave', '从锁存', master, pins.clk, { at: edge ?? 0 }, bit === undefined ? undefined : `s${bit}`, q)
    return this.output(m, 'Q', q)
  }

  latch(parent: Module, key: string, name: string, d: number, en: number, options: Options, state?: string, out?: number): number {
    const m = this.module(parent, key, 'latch', name, options)
    this.input(m, 'D', d)
    this.input(m, 'EN', en)
    const q = out ?? this.net(`${m.id}.Q`)
    const qn = this.net(`${m.id}.QN`)
    const nd = this.gate(m, 'nd', 'not', [d])
    const set = this.gate(m, 'set', 'and', [d, en])
    const reset = this.gate(m, 'reset', 'and', [nd, en])
    const first = this.gates.length
    const a = this.gate(m, 'orq', 'or', [reset, qn])
    this.gate(m, 'notq', 'not', [a], {}, q)
    const b = this.gate(m, 'orn', 'or', [set, q])
    this.gate(m, 'notn', 'not', [b], {}, qn)
    this.latches.push({ key: state, q, qn, loop: this.gates.slice(first) })
    return this.output(m, 'Q', q)
  }

  private markPorts(probes: Record<string, number[]>): void {
    const observed = new Set(Object.values(probes).flat())
    const external = new Set([...(probes.out ?? []), ...(probes.exit ?? [])])
    const readers = new Map<number, string[]>()
    for (const gate of this.gates) {
      if (!this.nets[gate.out]!.used) continue
      for (const id of gate.inputs) {
        if (id === gate.unselected) continue
        if (!readers.has(id)) readers.set(id, [])
        readers.get(id)!.push(gate.module.id)
      }
    }
    for (const module of this.modules.values()) {
      const inside = (id: string) => id === module.id || id.startsWith(`${module.id}/`)
      for (const p of module.ports) {
        p.used = module.kind === 'pad'
          // 观察点只证明内部算过这个值；Slice 端口要真有负载或是对外结果才算使用。
          || (p.dir === 'out' && (external.has(p.net) || (observed.has(p.net) && module.kind !== 'slice' && module.kind !== 'block')))
          || !!readers.get(p.net)?.some((id) => (p.dir === 'in') === inside(id))
      }
    }
  }

  /** I/O → 开关盒 → 连接盒 → 逻辑块。 */
  routeIn(name: string, sbAt: number, cbAt: number): number {
    const src = this.net(name, { input: name })
    const pad = this.module(this.root, `pad_${name}`, 'pad', name)
    this.output(pad, 'I', src)
    const sb = this.select(this.root, `sb_${name}`, `开关盒 ${name}`, 'I', src, { at: sbAt }, 'switch')
    const dst = this.select(this.root, `cb_${name}`, `连接盒 ${name}`, 'I', sb, { at: cbAt }, 'switch')
    const of = (key: string) => child(this.root, key)
    this.routes.push({ type: 'in', src, dst, pad, sb: of(`sb_${name}`), cb: of(`cb_${name}`) })
    return dst
  }

  routeOut(name: string, src: number, at: number): number {
    const dst = this.select(this.root, `sb_${name}`, `开关盒 ${name}`, 'I', src, { at }, 'switch')
    const pad = this.module(this.root, `pad_${name}`, 'pad', name, { at })
    this.input(pad, 'O', dst)
    this.routes.push({ type: 'out', src, dst, pad, sb: child(this.root, `sb_${name}`) })
    return dst
  }

  routeBack(name: string, src: number): number {
    const key = `back_${name}`
    const middle = this.select(this.root, `sb_${key}`, `反馈开关 ${name}`, 'I', src, { at: 0 }, 'switch')
    const dst = this.select(this.root, `cb_${key}`, `反馈连接盒 ${name}`, 'I', middle, { at: 0 }, 'switch')
    this.routes.push({ type: 'feedback', src, dst, sb: child(this.root, `sb_${key}`), cb: child(this.root, `cb_${key}`) })
    return dst
  }

  /** 逻辑块端口与其中各 Slice 的端口共用同一根线。 */
  blockPorts(block: Module): void {
    for (const slice of block.children) {
      for (const p of slice.ports) {
        // Slice 间的专用进位线留在逻辑块内部。
        const internal = block.children.some(
          (s) => s !== slice && s.ports.some((q) => q.dir !== p.dir && q.net === p.net))
        if (!internal) block.ports.push({ name: `${slice.key.toUpperCase()}.${p.name}`, dir: p.dir, net: p.net, used: false })
      }
    }
  }

  finish(idle: Module, probes: Record<string, number[]>): Design {
    const { nets, gates, latches, roles } = this
    const driver = new Map<number, Gate>()
    for (const gate of gates) {
      if (driver.has(gate.out)) throw new Error(`线有多个驱动：${nets[gate.out]!.name}`)
      driver.set(gate.out, gate)
    }

    // 只有观察点的扇入锥算“已使用”。
    const pending = Object.values(probes).flat()
    while (pending.length) {
      const id = pending.pop()!
      if (nets[id]!.used) continue
      nets[id]!.used = true
      const gate = driver.get(id)
      if (gate) pending.push(...gate.inputs.filter((input) => input !== gate.unselected))
    }

    // 锁存的 Q、QN 是状态源，其余门必须构成无环图。
    const stateNets = new Set(latches.flatMap((l) => [l.q, l.qn]))
    const order: Gate[] = []
    const marks = new Map<Gate, 'open' | 'done'>()
    const visit = (gate: Gate): void => {
      const mark = marks.get(gate)
      if (mark === 'done') return
      if (mark === 'open') throw new Error(`组合环：${gate.module.id}`)
      marks.set(gate, 'open')
      let stage = gate.module.at
      for (const id of gate.inputs) {
        const source = stateNets.has(id) ? undefined : driver.get(id)
        if (source) visit(source)
        stage = Math.max(stage, nets[id]!.at)
      }
      nets[gate.out]!.at = stage
      marks.set(gate, 'done')
      if (nets[gate.out]!.used) order.push(gate)
    }
    for (const gate of gates) if (!stateNets.has(gate.out)) visit(gate)
    this.markPorts(probes)

    return {
      arch: this.arch, example: this.example, root: this.root, idle, modules: this.modules,
      roles, nets, order, latches: latches.filter((l) => nets[l.q]!.used), routes: this.routes, probes,
    }
  }
}

/** 两套架构共用的按位观察点名字。 */
export function bitProbes(read: (i: number) => Record<string, number>): Record<string, number[]> {
  const result: Record<string, number[]> = {}
  for (const i of BITS) for (const [name, net] of Object.entries(read(i))) (result[name] ??= []).push(net)
  return result
}
