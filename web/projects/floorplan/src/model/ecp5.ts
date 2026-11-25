import { Builder, bitProbes, child, port, type Bit, type Design, type Module } from './cells.ts'
import { at, BITS, STAGES, type Example } from './stages.ts'

type BitStage = { p: number; s: number; c: number }

interface Half {
  init?: bigint
  /** Yosys 参数 INJECT1 = "NO" 时，本位参与进位运算。 */
  carry?: boolean
  pins?: Partial<Record<'A' | 'B' | 'C' | 'D', number>>
  stage?: BitStage
  bit?: number
  q?: number
  roles?: { lut?: string; carry?: string; ff?: string }
  equivalent?: { a: number; b: number }
}

interface SliceConfig {
  index: number
  name: string
  aux?: boolean
  ripple?: boolean
  fci?: number
  control?: { clk: number; ce: number; lsr: number }
  halves?: [Half, Half]
}

function slice(b: Builder, block: Module, config: SliceConfig): Module {
  const { index, name, aux, ripple = false, control } = config
  const m = b.module(block, `s${index}`, 'slice', name, { aux })
  const clk = b.input(m, 'CLK', control?.clk ?? b.open())
  const ce = b.input(m, 'CE', control?.ce ?? b.open())
  const lsr = b.input(m, 'LSR', control?.lsr ?? b.open())
  let carry = b.input(m, 'FCI', config.fci ?? b.open())
  const outputs: number[] = []
  const luts: number[] = []
  const selects: number[] = []

  for (const i of [0, 1]) {
    const half: Half = config.halves?.[i] ?? {}
    const stage = half.stage ?? { p: 0, s: 0, c: 0 }
    const pins = (['A', 'B', 'C', 'D'] as const).map((p): [string, number] =>
      [p, b.input(m, `${p}${i}`, half.pins?.[p] ?? b.open())])
    selects.push(b.input(m, `M${i}`, b.open()))
    const lut = b.lut(m, `lut${i}`, `LUT4 ${i}`, pins, half.init ?? 0n,
      { main: 'Z', tap: 'G', level: 2 }, { at: stage.p, role: half.roles?.lut })
    luts.push(lut.out)

    const cell = b.module(m, `ccu${i}`, 'ccu', `进位逻辑 ${i}`, { at: stage.s, role: half.roles?.carry })
    b.input(cell, 'L', lut.out)
    b.input(cell, 'G', lut.tap)
    b.input(cell, 'CI', carry)
    const enabled: Bit = half.carry ? 1 : 0
    const enable = b.config(cell, 'carryEnable', `进位参与（INJECT1=${enabled ? 'NO' : 'YES'}）`, enabled)
    const generate = b.gate(cell, 'generate', 'and', [lut.tap, enable], { at: stage.p })
    const gated = b.gate(cell, 'gated', 'and', [carry, enable])
    if (!enabled) {
      b.unselect(child(cell, 'generate'), lut.tap)
      b.unselect(child(cell, 'gated'), carry)
    }
    const sum = b.xor(cell, 'sum', '和异或门', lut.out, gated)
    const co = b.mux(cell, 'co', '进位选择器', generate, carry, lut.out, { at: stage.c })
    if (half.equivalent) b.adder(cell, half.equivalent.a, half.equivalent.b, carry, stage)
    b.output(cell, 'S', sum)
    b.output(cell, 'CO', co)
    carry = co

    const f = b.select(m, `fmux${i}`, `F${i} 选择器`, ripple ? 'S' : 'LUT',
      ripple ? sum : lut.out, { at: ripple ? stage.s : stage.p })
    const clocked = half.q !== undefined
    const q = b.flipFlop(m, `ff${i}`, `寄存器 ${i}`,
      { d: f, ce: clocked ? ce : b.open(), r: clocked ? lsr : b.open(), clk: clocked ? clk : b.open(), q: half.q },
      clocked
        ? { at: at('counter', 'ready'), edge: at('counter', 'rise'), bit: half.bit, role: half.roles?.ff }
        : {})
    outputs.push(f)
    b.output(m, `F${i}`, f)
    b.output(m, `Q${i}`, q)
  }

  const fxa = b.input(m, 'FXA', b.open())
  const fxb = b.input(m, 'FXB', b.open())
  b.output(m, 'OFX0', b.mux(m, 'wide0', 'LUT5 选择器', luts[1]!, luts[0]!, selects[0]!))
  b.output(m, 'OFX1', b.mux(m, 'wide1', 'LUT6/7/8 选择器', fxb, fxa, selects[1]!))
  b.output(m, 'FCO', carry)
  return m
}

function idlePfu(b: Builder): Module {
  const block = b.module(b.root, 'idle', 'block', '未使用的 PFU')
  let fci: number | undefined
  for (let index = 0; index < 4; index++) fci = port(slice(b, block, { index, name: `Slice ${index}`, fci }), 'FCO')
  b.blockPorts(block)
  return block
}

export function buildEcp5(example: Example): Design {
  const b = new Builder('ecp5', example)
  const one = () => b.constant(1)
  const last = STAGES[example].length - 1

  if (example === 'xor') {
    const route = at(example, 'route')
    const pinned = at(example, 'pins')
    const a = b.routeIn('A', route, pinned)
    const second = b.routeIn('B', route, pinned)
    const branch = at(example, 'branch')
    const block = b.module(b.root, 'block', 'block', 'PFU', { role: 'block' })
    const first = slice(b, block, {
      index: 0, name: 'Slice 0 · 异或',
      halves: [{
        init: 0x6666n, pins: { A: a, B: second, C: one(), D: one() },
        stage: { p: branch, s: branch, c: branch }, roles: { lut: 'lut:0' },
      }, {}],
    })
    let fci = port(first, 'FCO')
    for (const index of [1, 2, 3]) fci = port(slice(b, block, { index, name: `Slice ${index} · 未使用`, fci }), 'FCO')
    b.blockPorts(block)
    const out = b.routeOut('Y', port(first, 'F0'), last)
    return b.finish(idlePfu(b), {
      a: [a], b: [second], pins: [a, second], lut: [port(child(first, 'lut0'), 'Z')], out: [out],
    })
  }

  const counter = example === 'counter'
  const a: number[] = []
  const operandB: number[] = []
  let q: number[] | undefined
  let control: SliceConfig['control']
  if (counter) {
    control = { clk: b.routeIn('CLK', 0, 0), ce: b.routeIn('EN', 0, 0), lsr: b.routeIn('CLR', 0, 0) }
    q = BITS.map((i) => b.net(`Q${i}`))
    for (const i of BITS) {
      a[i] = b.routeBack(`Q${i}`, q[i]!)
      operandB[i] = b.constant(i === 0 ? 1 : 0, '加数 0001')
    }
  } else {
    const route = at(example, 'route')
    for (const i of BITS) a[i] = b.routeIn(`A${i}`, route, route)
    for (const i of BITS) operandB[i] = b.routeIn(`B${i}`, route, route)
  }

  const cinit = at(example, 'cinit')
  const exit = at(example, counter ? 'ready' : 'exit')
  const flat = (stage: number): BitStage => ({ p: stage, s: stage, c: stage })
  const block = b.module(b.root, 'block', 'block', 'PFU', { role: 'block' })

  const feedIn = slice(b, block, {
    index: 0, name: 'Slice 0 · 进位引入', aux: true, ripple: true,
    halves: [
      { init: 0x000an, carry: true, stage: flat(cinit), roles: { carry: 'cinit' },
        pins: { A: b.constant(0), B: one(), C: one(), D: one() } },
      { init: 0xffffn, stage: flat(cinit), pins: { A: one(), B: one(), C: one(), D: one() } },
    ],
  })

  const arithmetic = (i: number): Half => ({
    // bit 0 加 1；其余位加 0，LUT 只需传出 A。
    init: counter && i > 0 ? 0xaaaan : 0x66aan,
    carry: true,
    bit: i,
    stage: { p: at(example, `p${i}`), s: at(example, `s${i}`), c: at(example, `c${i}`) },
    pins: { A: a[i]!, B: counter ? one() : operandB[i]!, C: one(), D: one() },
    q: q?.[i],
    roles: { lut: `lut:${i}`, carry: `carry:${i}`, ff: `ff:${i}` },
    equivalent: { a: a[i]!, b: operandB[i]! },
  })
  const low = slice(b, block, {
    index: 1, name: 'Slice 1 · 运算 bit 1..0', ripple: true, fci: port(feedIn, 'FCO'), control,
    halves: [arithmetic(0), arithmetic(1)],
  })
  const high = slice(b, block, {
    index: 2, name: 'Slice 2 · 运算 bit 3..2', ripple: true, fci: port(low, 'FCO'), control,
    halves: [arithmetic(2), arithmetic(3)],
  })
  const feedOut = slice(b, block, {
    index: 3, name: 'Slice 3 · 进位引出', aux: true, ripple: true, fci: port(high, 'FCO'),
    halves: [
      { init: 0x0000n, carry: true, stage: flat(exit), roles: { carry: 'exit' },
        pins: { A: one(), B: one(), C: one(), D: one() } },
      { init: 0x000an, carry: true, stage: flat(exit), pins: { A: one(), B: one(), C: one(), D: one() } },
    ],
  })
  b.blockPorts(block)

  const owner = (i: number) => (i < 2 ? low : high)
  const probes = bitProbes((i) => {
    const cell = child(owner(i), `ccu${i % 2}`)
    const ff = child(owner(i), `ff${i % 2}`)
    const fa = child(cell, 'fa')
    return {
      a: a[i]!, b: operandB[i]!, p: port(cell, 'L'), cin: port(cell, 'CI'), sum: port(cell, 'S'), cout: port(cell, 'CO'),
      faSum: port(fa, 'Sum'), faCout: port(fa, 'Cout'),
      ...(q && { d: port(ff, 'D'), next: port(child(ff, 'master'), 'D'), captured: port(child(ff, 'master'), 'Q'), q: q[i]! }),
    }
  })
  probes.exit = [port(feedOut, 'F0')]
  probes.out = counter
    ? BITS.map((i) => b.routeOut(`Q${i}`, q![i]!, 0))
    : [
        ...BITS.map((i) => b.routeOut(`S${i}`, port(owner(i), `F${i % 2}`), last)),
        b.routeOut('Cout', port(feedOut, 'F0'), last),
      ]
  return b.finish(idlePfu(b), probes)
}
