import { Builder, bitProbes, child, port, type Design, type Module } from './cells.ts'
import { at, BITS, STAGES, type Example } from './stages.ts'

const LETTER = ['A', 'B', 'C', 'D'] as const
const XOR_INIT = 0x6666666666666666n
/** 高 32 位供 O6：bit 0 为 ~A1，其余为 A1；低 32 位供 O5：常量 0001。 */
const COUNT_INIT = [0x55555555ffffffffn, 0xaaaaaaaa00000000n, 0xaaaaaaaa00000000n, 0xaaaaaaaa00000000n] as const

type BitStage = { p: number; s: number; c: number }

interface SliceConfig {
  key: string
  name: string
  aux?: boolean
  /** 外部已接好的引脚；未列出的保持未连接。 */
  pins?: Record<string, number>
  init?: readonly bigint[]
  di: 'X' | 'O5'
  main?: boolean
  stage: (i: number) => BitStage
  initStage?: number
  q?: number[]
  equivalent?: (i: number) => { a: number; b: number }
}

function slice(b: Builder, block: Module, config: SliceConfig): Module {
  const { key, name, aux, pins = {}, main } = config
  const m = b.module(block, key, 'slice', name, { aux })
  const pin = (p: string) => b.input(m, p, pins[p] ?? b.open())
  const carry0 = pin('CIN')
  const clk = pin('CLK')
  const ce = pin('CE')
  const sr = pin('SR')

  const lanes = BITS.map((i) => {
    const X = LETTER[i]
    const stage = config.stage(i)
    const address = [1, 2, 3, 4, 5, 6].map((n): [string, number] => [`A${n}`, pin(`${X}${n}`)])
    const bypass = pin(`${X}X`)
    const lut = b.lut(m, `lut${X}`, `LUT6 ${X}`, address, config.init?.[i] ?? 0n,
      { main: 'O6', tap: 'O5', level: 5 }, { at: stage.p, role: main ? `lut:${i}` : undefined })
    const di = b.configuredMux(m, `cy0${X}`, `${X}CY0`, bypass, lut.tap, config.di === 'O5' ? 1 : 0, { at: stage.p })
    return { i, X, stage, address, bypass, di, ...lut }
  })

  b.mux(m, 'f7a', 'F7AMUX', lanes[1]!.out, lanes[0]!.out, lanes[0]!.bypass)
  b.mux(m, 'f7b', 'F7BMUX', lanes[3]!.out, lanes[2]!.out, lanes[2]!.bypass)
  b.mux(m, 'f8', 'F8MUX', port(child(m, 'f7b'), 'O'), port(child(m, 'f7a'), 'O'), lanes[1]!.bypass)

  const initial = config.initStage ?? 0
  const cyinit = b.select(m, 'cyinit', 'CYINIT = 0', '0', b.constant(0),
    { at: initial, role: main ? 'cinit' : undefined })
  const carry4 = b.module(m, 'carry4', 'carry4', 'CARRY4', { at: initial })
  b.input(carry4, 'CI', carry0)
  b.input(carry4, 'CYINIT', cyinit)
  for (const lane of lanes) {
    b.input(carry4, `S${lane.i}`, lane.out)
    b.input(carry4, `DI${lane.i}`, lane.di)
  }
  let carry = b.gate(carry4, 'c0', 'or', [carry0, cyinit])
  const chain = lanes.map(({ i, out, di, stage }) => {
    const role = main ? `carry:${i}` : i === 0 && aux ? 'exit' : undefined
    const bit = b.module(carry4, `bit${i}`, 'carrybit', `进位级 ${i}`, { at: stage.s, role })
    b.input(bit, 'S', out)
    b.input(bit, 'DI', di)
    b.input(bit, 'CI', carry)
    const sum = b.xor(bit, 'sum', 'XORCY', out, carry)
    const co = b.mux(bit, 'co', 'MUXCY', di, carry, out, { at: stage.c })
    const operands = config.equivalent?.(i)
    if (operands) b.adder(bit, operands.a, operands.b, carry, stage)
    b.output(bit, 'O', sum)
    b.output(bit, 'CO', co)
    b.output(carry4, `O${i}`, sum)
    b.output(carry4, `CO${i}`, co)
    const entry = { cin: carry, sum, co }
    carry = co
    return entry
  })

  for (const { i, X, out, stage } of lanes) {
    const { sum } = chain[i]!
    const d = b.select(m, `ffmux${X}`, `${X}FFMUX`, 'XOR', sum, { at: stage.s })
    const toMux = b.select(m, `outmux${X}`, `${X}OUTMUX`, 'XOR', sum, { at: stage.s })
    const q = config.q?.[i]
    const clocked = q !== undefined
    const Q = b.flipFlop(m, `ff${X}`, `${X}FF（FF/锁存）`,
      { d, ce: clocked ? ce : b.open(), r: clocked ? sr : b.open(), clk: clocked ? clk : b.open(), q },
      clocked
        ? { at: at('counter', 'ready'), edge: at('counter', 'rise'), bit: i, role: `ff:${i}` }
        : {})
    b.flipFlop(m, `ff5${X}`, `${X}5FF（仅 FF）`, { d: b.open(), ce: b.open(), r: b.open(), clk: b.open() }, {})
    b.output(m, X, out)
    b.output(m, `${X}MUX`, toMux)
    b.output(m, `${X}Q`, Q)
  }
  b.output(m, 'COUT', carry)
  return m
}

function idleClb(b: Builder): Module {
  const block = b.module(b.root, 'idle', 'block', '未使用的 CLB')
  for (const i of [0, 1]) slice(b, block, { key: `s${i}`, name: `Slice(${i})`, di: 'X', stage: () => ({ p: 0, s: 0, c: 0 }) })
  b.blockPorts(block)
  return block
}

export function buildAmd(example: Example): Design {
  const b = new Builder('amd', example)
  const arithmetic = example !== 'xor'
  const stage = (i: number): BitStage => arithmetic
    ? { p: at(example, `p${i}`), s: at(example, `s${i}`), c: at(example, `c${i}`) }
    : { p: at('xor', 'branch'), s: 0, c: 0 }

  const pins: Record<string, number> = {}
  const tie = (i: number, from: number) => {
    for (let n = from; n <= 6; n++) pins[`${LETTER[i]}${n}`] = b.constant(1)
  }
  const a: number[] = []
  const operandB: number[] = []
  let q: number[] | undefined
  let init: readonly bigint[]

  if (example === 'xor') {
    pins.A1 = b.routeIn('A', at(example, 'route'), at(example, 'pins'))
    pins.A2 = b.routeIn('B', at(example, 'route'), at(example, 'pins'))
    tie(0, 3)
    init = [XOR_INIT]
  } else if (example === 'adder') {
    const route = at(example, 'route')
    for (const i of BITS) a[i] = b.routeIn(`A${i}`, route, route)
    for (const i of BITS) operandB[i] = b.routeIn(`B${i}`, route, route)
    for (const i of BITS) {
      pins[`${LETTER[i]}1`] = a[i]!
      pins[`${LETTER[i]}2`] = operandB[i]!
      pins[`${LETTER[i]}X`] = a[i]!
      tie(i, 3)
    }
    pins.CIN = b.constant(0)
    init = [XOR_INIT, XOR_INIT, XOR_INIT, XOR_INIT]
  } else {
    pins.CLK = b.routeIn('CLK', 0, 0)
    pins.CE = b.routeIn('EN', 0, 0)
    pins.SR = b.routeIn('CLR', 0, 0)
    q = BITS.map((i) => b.net(`Q${i}`))
    for (const i of BITS) {
      a[i] = b.routeBack(`Q${i}`, q[i]!)
      operandB[i] = b.constant(i === 0 ? 1 : 0, '加数 0001')
      pins[`${LETTER[i]}1`] = a[i]!
      tie(i, 2)
    }
    pins.CIN = b.constant(0)
    init = COUNT_INIT
  }

  const block = b.module(b.root, 'block', 'block', 'CLB', { role: 'block' })
  const main = slice(b, block, {
    key: 's0', name: arithmetic ? 'Slice(0) · 运算 bit 3..0' : 'Slice(0) · 异或',
    pins, init, q, main: true, stage,
    di: example === 'counter' ? 'O5' : 'X',
    initStage: arithmetic ? at(example, 'cinit') : 0,
    equivalent: arithmetic ? (i) => ({ a: a[i]!, b: operandB[i]! }) : undefined,
  })
  slice(b, block, { key: 's1', name: 'Slice(1) · 未使用', di: 'X', stage: () => ({ p: 0, s: 0, c: 0 }) })
  b.blockPorts(block)
  const last = STAGES[example].length - 1

  if (!arithmetic) {
    const out = b.routeOut('Y', port(main, 'A'), last)
    return b.finish(idleClb(b), {
      a: [pins.A1!], b: [pins.A2!], pins: [pins.A1!, pins.A2!], lut: [port(main, 'A')], out: [out],
    })
  }

  const carry4 = child(main, 'carry4')
  const probes = bitProbes((i) => {
    const X = LETTER[i]!
    const bit = child(carry4, `bit${i}`)
    const fa = child(bit, 'fa')
    return {
      a: a[i]!, b: operandB[i]!, p: port(bit, 'S'), cin: port(bit, 'CI'), sum: port(bit, 'O'), cout: port(bit, 'CO'),
      faSum: port(fa, 'Sum'), faCout: port(fa, 'Cout'),
      ...(q && {
        d: port(child(main, `ff${X}`), 'D'),
        next: port(child(child(main, `ff${X}`), 'master'), 'D'),
        captured: port(child(child(main, `ff${X}`), 'master'), 'Q'),
        q: q[i]!,
      }),
    }
  })

  if (example === 'adder') {
    const exit = at(example, 'exit')
    const upper = b.module(b.root, 'helper', 'block', '上方相邻 CLB', { role: 'helper', aux: true })
    const helperPins: Record<string, number> = { CIN: port(main, 'COUT') }
    for (let n = 1; n <= 6; n++) helperPins[`A${n}`] = b.constant(1)
    const helper = slice(b, upper, {
      key: 's0', name: 'Slice(0) · 进位引出', aux: true, pins: helperPins, di: 'O5', initStage: exit,
      stage: () => ({ p: exit, s: exit, c: exit }),
    })
    slice(b, upper, { key: 's1', name: 'Slice(1) · 未使用', di: 'X', stage: () => ({ p: 0, s: 0, c: 0 }) })
    b.blockPorts(upper)
    probes.out = [
      ...BITS.map((i) => b.routeOut(`S${i}`, port(main, `${LETTER[i]}MUX`), last)),
      b.routeOut('Cout', port(helper, 'AMUX'), last),
    ]
    probes.exit = [port(helper, 'AMUX')]
  } else {
    probes.out = BITS.map((i) => b.routeOut(`Q${i}`, q![i]!, 0))
  }
  return b.finish(idleClb(b), probes)
}
