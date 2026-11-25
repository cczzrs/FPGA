import type { Demo, Family } from '../scene/types.ts'

export const families = {
  amd: {
    name: 'AMD 7 系列',
    short: 'AMD 7 SERIES',
    block: 'CLB',
    blockName: '可配置逻辑块',
    slices: 2,
    lanes: 4,
    registers: 8,
    width: 6,
    carry: 'CARRY4',
    ram: 'BRAM'
  },
  ecp5: {
    name: 'Lattice ECP5',
    short: 'LATTICE ECP5',
    block: 'PFU',
    blockName: '可编程功能单元',
    slices: 4,
    lanes: 2,
    registers: 2,
    width: 4,
    carry: 'CCU2',
    ram: 'EBR'
  }
} as const

export interface Inputs {
  a: number
  b: number
  en: boolean
  reset: boolean
}
export interface ClockState {
  q: number
  clk: number
  master: number
  sampledD: number
}
export const initialClock = (): ClockState => ({ q: 0, clk: 0, master: 0, sampledD: 0 })
export const defaultInputs = (demo: Demo): Inputs => ({
  a: demo === 'adder' ? 7 : 1,
  b: demo === 'adder' ? 1 : 0,
  en: true,
  reset: false
})
export const bit = (value: number, index: number) => (value >> index) & 1
export const binary = (value: number, width = 4) => value.toString(2).padStart(width, '0')
export const mux = (s: number, a: number, b: number) => ((s ^ 1) & a) | (s & b)
export const xor = (a: number, b: number) => (a & (b ^ 1)) | ((a ^ 1) & b)
export type Signals = Record<string, number>
export interface Phase {
  name: string
  detail: string
  active: string[]
}
export interface LutTrace {
  address: number
  rows: number[][]
  selected: string[]
  names: string[][]
  result: number
}
export interface Snapshot {
  family: Family
  demo: Demo
  values: Signals
  luts: LutTrace[]
  phases: Phase[]
  usedBits: number
}

/** The physical address inputs above I1 are tied low in these examples. */
export function evaluateLut(width: number, lane: number, a: number, b: number, values: Signals): LutTrace {
  const address = a | (b << 1)
  const rows = [Array.from({ length: 1 << width }, (_, i) => xor(bit(i, 0), bit(i, 1)))]
  const names: string[][] = []
  const selected: string[] = []
  for (let tier = 0; tier <= width; tier++) {
    const prefix = 'L' + lane + (tier === 0 ? 'M' : 'T' + tier + 'N')
    const row = rows[tier]
    const rowNames = row.map((value, i) => {
      const name = prefix + i
      values[name] = value
      return name
    })
    names.push(rowNames)
    selected.push(rowNames[address >> tier])
    if (tier < width) {
      const select = bit(address, tier)
      values['L' + lane + 'I' + tier] = select
      const next: number[] = []
      for (let i = 0; i < row.length; i += 2) next.push(mux(select, row[i], row[i + 1]))
      rows.push(next)
    }
  }
  return { address, rows, names, selected, result: rows[width][0] }
}

export function simulate(family: Family, demo: Demo, input: Inputs, clock: ClockState): Snapshot {
  const spec = families[family]
  const a = demo === 'counter' ? clock.q : input.a
  const b = demo === 'counter' ? 1 : input.b
  const values: Signals = { A: a, B: b, C0: 0 }
  const luts: LutTrace[] = []
  const phases: Phase[] = []
  const usedBits = demo === 'xor' ? 1 : 4
  let sum = 0
  for (let lane = 0; lane < usedBits; lane++) {
    const ai = bit(a, lane),
      bi = bit(b, lane)
    values['A' + lane] = ai
    values['B' + lane] = bi
    const lut = evaluateLut(spec.width, lane, ai, bi, values)
    const p = lut.result
    luts.push(lut)
    values['P' + lane] = p
    if (demo !== 'xor') {
      const ci = values['C' + lane]
      // In an AMD adder the DI bypass can supply A. CCU2 uses equivalent generate logic.
      const di = family === 'amd' ? ai : ai & bi
      values['DI' + lane] = di
      values['C' + (lane + 1)] = mux(p, di, ci)
      values['S' + lane] = xor(p, ci)
      sum |= values['S' + lane] << lane
    }
  }
  const inputLines = ['A', 'B', ...luts.flatMap((_, n) => ['A' + n, 'B' + n])]
  const lutLines = luts.flatMap((lut, n) => [...lut.selected, 'P' + n])
  if (demo === 'xor') {
    values.Y = luts[0].result
    phases.push(
      {
        name: '输入寻址',
        detail: 'A 和 B 由输入引脚进入逻辑块，分别驱动 LUT 的 I0 和 I1。',
        active: [...inputLines, 'L0I0', 'L0I1']
      },
      {
        name: 'LUT 查表',
        detail:
          '地址 ' + binary(luts[0].address, spec.width) + ' 选中配置位，沿选择器树读出 ' + values.Y + '。',
        active: lutLines
      },
      {
        name: '输出就绪',
        detail: '组合输出 Y 为 ' + values.Y + '，经可编程互连送往输出引脚。',
        active: ['P0', 'Y']
      }
    )
  } else {
    values.SUM = sum
    if (demo === 'adder') {
      phases.push({
        name: '装入操作数',
        detail: 'A 和 B 的各位送往对应 LUT，最低位进位 C0 固定为 0。',
        active: [...inputLines, 'C0']
      })
      for (let n = 0; n < 4; n++) {
        const lut = luts[n]
        phases.push({
          name: '第 ' + n + ' 位进位',
          detail:
            '位 ' +
            n +
            ' 读入 C' +
            n +
            '=' +
            values['C' + n] +
            '，得到和位 ' +
            values['S' + n] +
            ' 与进位 C' +
            (n + 1) +
            '=' +
            values['C' + (n + 1)] +
            '。',
          active: ['A' + n, 'B' + n, ...lut.selected, 'P' + n, 'DI' + n, 'C' + n, 'S' + n, 'C' + (n + 1)]
        })
      }
      phases.push({
        name: '读取结果',
        detail: '四个和位组成 ' + binary(sum) + '，最高位进位 C4 为 ' + values.C4 + '。',
        active: ['S0', 'S1', 'S2', 'S3', 'C4', 'SUM']
      })
    } else {
      Object.assign(values, {
        CLK: clock.clk,
        Q: clock.q,
        D: sum,
        EN: Number(input.en),
        RST: Number(input.reset)
      })
      const effective = input.reset ? 0 : input.en ? sum : clock.q
      for (let n = 0; n < 4; n++) {
        values['Q' + n] = bit(clock.q, n)
        values['D' + n] = bit(sum, n)
        values['E' + n] = bit(effective, n)
        values['M' + n] = bit(clock.clk ? clock.master : effective, n)
      }
      phases.push(
        {
          name: '状态反馈',
          detail: '寄存器 Q=' + binary(clock.q) + ' 经反馈线进入加一电路。',
          active: ['Q', 'A', ...[0, 1, 2, 3].flatMap((n) => ['Q' + n, 'A' + n])]
        },
        {
          name: '计算下一状态',
          detail: '加一电路的结果 ' + binary(sum) + ' 到达 D 端，等待上升沿。',
          active: [
            ...lutLines,
            'C1',
            'C2',
            'C3',
            'C4',
            'S0',
            'S1',
            'S2',
            'S3',
            'SUM',
            'D',
            'D0',
            'D1',
            'D2',
            'D3'
          ]
        },
        {
          name: '上升沿采样',
          detail: '此沿的 D=' + binary(clock.sampledD) + '。采样后的 Q=' + binary(clock.q) + '。',
          active: ['CLK', 'EN', 'RST', 'Q', 'Q0', 'Q1', 'Q2', 'Q3']
        },
        {
          name: '寄存器保持',
          detail: '在下一次上升沿之前，Q 保持 ' + binary(clock.q) + '。',
          active: ['CLK', 'Q', 'Q0', 'Q1', 'Q2', 'Q3']
        }
      )
    }
  }
  if (family === 'ecp5' && demo !== 'xor') {
    const buses = demo === 'counter' ? ['A', 'B', 'SUM', 'Q', 'D'] : ['A', 'B', 'SUM']
    for (const bus of buses)
      for (const first of [0, 2]) {
        const pair = bus + '[' + (first + 1) + ':' + first + ']'
        values[pair] = (values[bus] >> first) & 3
        const lane = bus === 'SUM' ? 'S' : bus
        for (const phase of phases) {
          if ([bus, lane + first, lane + (first + 1)].some((net) => phase.active.includes(net)))
            phase.active.push(pair)
        }
      }
  }
  return { family, demo, values, luts, phases, usedBits }
}

export function toggleClock(clock: ClockState, input: Inputs, snapshot: Snapshot): ClockState {
  if (clock.clk) return { ...clock, clk: 0 }
  const sampledD = snapshot.values.D
  const q = input.reset ? 0 : input.en ? sampledD : clock.q
  return { q, master: q, sampledD, clk: 1 }
}
