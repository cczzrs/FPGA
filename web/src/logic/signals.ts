import type { GateGraph } from './gates.ts'
import type { Snapshot } from './simulator.ts'
import type { Location } from '../scene/types.ts'

const fixed: Record<string, string> = {
  A: '#a5e875',
  B: '#53d6da',
  Y: '#ffbb6c',
  SUM: '#f0997f',
  Q: '#ec91c5',
  D: '#ad99fc',
  CLK: '#6eb9ff',
  EN: '#e6c659',
  RST: '#ff8179',
  gl: '#f0a96c',
  gh: '#b998ed',
  gsel: '#69bff1',
  gnot: '#f090bb',
  glo: '#8bdd89',
  ghigh: '#e5ce68',
  gor: '#5cdbc8',
  ga: '#a5e875',
  gb: '#53d6da',
  gc: '#e6bd67',
  gp: '#c18aee',
  gs: '#ed966b',
  ggen: '#a0a7f5',
  gn: '#62b9ed',
  glu: '#ea8bad',
  ghi: '#64d3ba',
  gco: '#f5cf78',
  gd: '#ad99fc',
  gclk: '#6eb9ff',
  gdn: '#ffb98b',
  gcn: '#8adda0',
  gms: '#ec94c8',
  gmr: '#ecdb78',
  gm: '#71ded2',
  gmb: '#bdaaed',
  gss: '#9ecfff',
  gsr: '#b5db79',
  gq: '#f48e9e',
  gqb: '#f5bb68'
}
function hash(name: string) {
  let n = 0
  for (const c of name) n = (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0
  return n
}
export function netColor(name: string): string {
  if (name.startsWith('unused-') || name.startsWith('idle')) return '#61756f'
  if (fixed[name]) return fixed[name]
  const n = hash(name)
  const lut = /^L(\d+)(?:T(\d+)N|M)(\d+)$/.exec(name)
  if (lut) {
    const hue = (15 + Number(lut[1]) * 29 + Number(lut[2] ?? 0) * 101 + Number(lut[3]) * 137.508) % 360
    return `hsl(${hue.toFixed(2)}, 72%, ${63 + (n % 10)}%)`
  }
  const prefix = /^(DI|[ABCPSQDEM])(?:\d+|\[)/.exec(name)?.[1]
  const base: Record<string, number> = {
    A: 93,
    B: 176,
    C: 38,
    P: 271,
    S: 13,
    Q: 332,
    D: 250,
    DI: 58,
    E: 205,
    M: 295
  }
  const k = Number(name.match(/\d+/)?.[0] ?? 0)
  const hue = prefix ? (base[prefix] + k * 13) % 360 : (n * 137.507764) % 360
  return 'hsl(' + hue.toFixed(2) + ', ' + (64 + (n % 15)) + '%, ' + (63 + (n % 12)) + '%)'
}
export function signalValue(net: string, s: Snapshot, graph?: GateGraph) {
  const v = graph ? (Object.hasOwn(graph.values, net) ? graph.values[net] : s.values[net]) : s.values[net]
  if (v === undefined) return '—'
  const width = net.includes('[')
    ? 2
    : ['SUM', 'Q', 'D'].includes(net) || (['A', 'B'].includes(net) && s.demo !== 'xor')
      ? 4
      : 1
  return v.toString(2).padStart(width, '0')
}
export function explainSignal(net: string, s: Snapshot, loc: Location, graph?: GateGraph) {
  const node = graph?.nodes.find((g) => g.id === net)
  if (node && graph) {
    const sinks = graph.nodes.filter((g) => g.inputs.includes(net)).map((g) => g.name)
    return {
      name: node.name,
      from: node.op === 'IN' ? '输入端 ' + node.name : node.name + ' 输出',
      to: sinks.join('、') || '输出端',
      purpose: node.op === 'IN' ? '为等效门电路提供输入。' : '把 ' + node.op + ' 的结果送给后续门或反馈端。'
    }
  }
  const mem = /^L(\d+)M(\d+)$/.exec(net),
    tree = /^L(\d+)T(\d+)N(\d+)$/.exec(net)
  if (mem)
    return {
      name: '配置位 ' + mem[2],
      from: 'LUT 配置位 [' + mem[2] + ']',
      to: '第 1 层 MUX[' + (Number(mem[2]) >> 1) + ']',
      purpose: '该存储位提供查找表的一位真值。'
    }
  if (tree) {
    const t = Number(tree[2]),
      i = Number(tree[3])
    return {
      name: 'MUX ' + t + '.' + i,
      from: '第 ' + t + ' 层 MUX[' + i + ']',
      to: t === (s.family === 'amd' ? 6 : 4) ? 'LUT 输出' : '第 ' + (t + 1) + ' 层 MUX[' + (i >> 1) + ']',
      purpose: '将当前选择的真值送入下一级。'
    }
  }
  if (net === 'wide0' || net === 'wide1' || net === 'wideY') {
    const label = loc.muxName ?? '宽函数 MUX',
      output = net === 'wideY',
      port = output ? 'O' : 'I' + net.at(-1)
    return {
      name: port,
      from: output ? label + ' 输出' : '逻辑输入 ' + port,
      to: output ? '输出端 O' : label + ' 的 ' + port,
      purpose: output
        ? '输出选择器选通的数据，当前示例未分配此资源。'
        : '向宽函数选择器提供一个候选输入，当前示例未分配此资源。'
    }
  }
  const bare = net.replace(/\[.*?\]|\d+/g, '')
  const lane = net.match(/\d+/)?.[0]
  let src = '',
    dst = '',
    purpose = ''
  switch (bare) {
    case 'A':
    case 'B':
      src = s.demo === 'counter' ? (bare === 'A' ? '寄存器 Q' : '常数 1') : '输入 ' + bare
      dst = 'LUT 地址端 ' + (bare === 'A' ? 'I0' : 'I1')
      purpose = '传送' + (lane === undefined ? '操作数' : '对应的操作数位') + '，参与查表。'
      break
    case 'P':
      src = 'LUT' + (lane ?? '') + ' 输出'
      dst = s.demo === 'xor' ? '输出互连' : '进位选择端与求和 XOR'
      purpose = '传播位等于两个操作数位的异或。'
      break
    case 'C': {
      const i = Number(lane ?? 0)
      src = i === 0 ? '固定初始进位 0' : '位 ' + (i - 1) + ' 的进位输出'
      dst = i === 4 ? '最高位进位观察端' : '位 ' + i + ' 的进位输入'
      purpose =
        s.family === 'ecp5' && i === 2
          ? '从 Slice 0 的高位进入相邻 Slice 1 的低位。'
          : '传递相邻算术位之间的进位。'
      break
    }
    case 'DI':
      src = s.family === 'amd' ? '操作数旁路' : '生成逻辑'
      dst = '进位多路选择器 DI'
      purpose = '传播条件为 0 时采用该进位数据。'
      break
    case 'S':
    case 'SUM':
      src = '进位单元的求和 XOR'
      dst = s.demo === 'counter' ? '寄存器 D' : '输出互连'
      purpose = '传送本次加法的和。'
      break
    case 'Y':
      src = 'LUT 输出'
      dst = '输出引脚 Y'
      purpose = '异或组合结果经可编程互连送出。'
      break
    case 'CLK':
      src = '时钟网络'
      dst = '寄存器时钟端'
      purpose = '上升沿按同步清零、使能的优先级采样。'
      break
    case 'EN':
      src = '使能输入'
      dst = '寄存器 CE'
      purpose = '允许在有效时钟沿写入数据。'
      break
    case 'RST':
      src = '同步清零输入'
      dst = '寄存器 SR / LSR'
      purpose = '有效上升沿将寄存器清零。'
      break
    case 'Q':
      src = '寄存器 Q'
      dst = '加一电路与输出端'
      purpose = '将已保存的状态反馈至下一次计算。'
      break
    case 'D':
      src = '加一电路'
      dst = '寄存器 D'
      purpose = '向寄存器提供下一次采样的数据。'
      break
    case 'E':
      src = '使能与清零选择'
      dst = '主锁存器'
      purpose = '传递本周期的有效 D。'
      break
    case 'M':
      src = '主锁存器'
      dst = '从锁存器'
      purpose = '传递在时钟相位转换时保持的状态。'
      break
    default:
      src = loc.unit === 'mux' ? '宽函数选择器端口' : '局部端口'
      dst = '相邻逻辑单元'
      purpose = '此资源在当前示例中空闲。'
  }
  return { name: net, from: src, to: dst, purpose }
}
