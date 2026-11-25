import './style.css'
import './desktop.css'
import { shell } from './desktop-view.ts'
import { setupDesktop } from './desktop.ts'
import { resourceIdFor, sampleBlock, type ResourceNode } from './logic/hierarchy.ts'
import { ResourceTree } from './resource-tree.ts'
import { chipResources } from './scene/resources.ts'
import { startTiming, tick } from './logic/clock.ts'
import { wirePanel } from './wire-panel.ts'
import { binary, bit, defaultInputs, families, simulate, type Snapshot } from './logic/simulator.ts'
import { gateGraph, type GateGraph } from './logic/gates.ts'
import { buildChip } from './scene/chip.ts'
import { buildBlock, buildSlice } from './scene/fabric.ts'
import { buildGates, buildUnit } from './scene/detail.ts'
import { Stage } from './scene/stage.ts'
import { parentOutline } from './scene/locator.ts'
import type { Demo, Family, Jump, Level, Location, Unit } from './scene/types.ts'
import { icon } from './ui.ts'

const get = (id: string) => document.getElementById(id)!
get('app').innerHTML = shell()
const levels: Level[] = ['chip', 'block', 'slice', 'unit', 'gate']
const desktop = setupDesktop()
const names: Record<Demo, string> = { xor: 'LUT 异或', adder: '4 位加法器', counter: '同步计数器' }
const unitLabels = (family: Family): Record<Unit, string> => ({
  lut: 'LUT' + families[family].width,
  mux: '宽函数 MUX',
  carry: families[family].carry,
  ff: 'D 触发器'
})
let family: Family = 'amd',
  demo: Demo = 'xor'
let loc: Location = { level: 'chip', slice: 0, unit: 'lut', bit: 0 }
const inputs = {
  xor: defaultInputs('xor'),
  adder: defaultInputs('adder'),
  counter: defaultInputs('counter')
}
let timing = startTiming(),
  clock = timing.clock,
  hz = 0.25
let chosen: ResourceNode | undefined,
  solo = '',
  netNames: string[] = []
const tree = new ResourceTree(get('tree'), (n) => {
  if (n.jump) {
    navigate(n.jump, n)
    return
  }
  if (n.inspect) navigate({ level: 'chip' }, n)
})
let step = 0,
  probeIndex = 0,
  speed = 1,
  playing = false
let timer: ReturnType<typeof setTimeout> | undefined
let assetKey = '',
  contextKey = ''
let snapshot = simulate(family, demo, inputs[demo], clock)
let graph: GateGraph | undefined
type Sample = { clk: number; d: number; q: number; t: number }
let history: Sample[] = [{ clk: 0, d: 1, q: 0, t: 0 }]
function record() {
  const s = simulate(family, demo, inputs[demo], clock)
  history.push({ clk: clock.clk, d: s.values.D ?? 0, q: clock.q, t: timing.elapsed })
  history = history.slice(-24)
}
function clockQuarters(count: number) {
  for (let i = 0; i < count; i++) {
    const s = simulate(family, demo, inputs[demo], clock)
    timing = tick(timing, hz, inputs[demo], s)
    clock = timing.clock
    record()
  }
}
function put(id: string, html: string) {
  const el = get(id)
  if (el.dataset.markup === html) return
  const focused = el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null
  const focus = focused?.dataset
  const focusKey = focus?.action || focus?.setting
  const focusValue = focus?.value
  el.innerHTML = html
  el.dataset.markup = html
  if (focused?.id) get(focused.id)?.focus({ preventScroll: true })
  else if (focusKey)
    [...el.querySelectorAll<HTMLElement>('button,select')]
      .find((n) => (n.dataset.action || n.dataset.setting) === focusKey && n.dataset.value === focusValue)
      ?.focus({ preventScroll: true })
}
function btn(action: string, value: string, text: string, selected: boolean, klass = '') {
  return (
    '<button data-action="' +
    action +
    '" data-value="' +
    value +
    '" aria-pressed="' +
    selected +
    '" class="' +
    klass +
    (selected ? ' selected' : '') +
    '">' +
    text +
    '</button>'
  )
}
function stop() {
  playing = false
  clearTimeout(timer)
}
function navigate(jump: Jump, selected?: ResourceNode) {
  chosen = selected
  const oldLevel = loc.level
  if (oldLevel !== jump.level) solo = ''
  const spec = families[family]
  const slice = jump.slice ?? (jump.bit === undefined ? loc.slice : Math.floor(jump.bit / spec.lanes))
  const lane = jump.bit ?? (slice !== loc.slice ? slice * spec.lanes : loc.bit)
  const unit = jump.unit ?? loc.unit
  const same = lane === loc.bit && unit === loc.unit && (!jump.unit || jump.level === 'gate')
  loc = {
    level: jump.level,
    block: jump.block ?? (jump.level === 'chip' ? undefined : (loc.block ?? sampleBlock(family))),
    probe: jump.probe,
    slice,
    unit,
    bit: lane,
    tier: jump.tier ?? (same ? loc.tier : undefined),
    muxIndex: jump.muxIndex ?? (same ? loc.muxIndex : undefined),
    secondaryFF: jump.secondaryFF ?? (same ? loc.secondaryFF : false),
    muxName: jump.muxName ?? (same ? loc.muxName : undefined)
  }
  probeIndex = 0
  render()
}
function selectProbe(id: string) {
  const p = graph?.probes.findIndex((n) => n.id === id) ?? -1
  if (p !== -1) {
    chosen = undefined
    probeIndex = p
    stop()
    render()
  }
}
let stage: Stage | undefined
try {
  stage = new Stage(
    get('stage'),
    navigate,
    selectProbe,
    (id) => {
      solo = solo === id ? '' : id
      desktop.showWires()
      render()
    },
    (id) => tree.pick(id)
  )
} catch (error) {
  console.error('WebGL initialization', error)
  get('stage').innerHTML =
    '<div class="webgl-error"><strong>三维视图需要 WebGL 2</strong><p>请启用浏览器硬件加速并刷新。下方的电路、波形和层级导航仍可操作。</p></div>'
}

function pathLabels() {
  const f = families[family],
    units = unitLabels(family)
  return [
    '芯片总览',
    f.block + (loc.block ? ' ' + loc.block : ''),
    'Slice ' + loc.slice,
    units[loc.unit],
    '等效门'
  ]
}
function nav() {
  const f = families[family],
    depth = levels.indexOf(loc.level)
  const labels = pathLabels()
  put(
    'parent-map',
    depth
      ? '<button data-action="level" data-value="' +
          levels[depth - 1] +
          '" aria-label="返回' +
          labels[depth - 1] +
          '" title="返回' +
          labels[depth - 1] +
          '">' +
          parentOutline(family, loc) +
          '<span>上级 · ' +
          labels[depth - 1] +
          '</span></button>'
      : ''
  )
  put(
    'families',
    (['amd', 'ecp5'] as Family[]).map((id) => btn('family', id, families[id].name, family === id)).join('')
  )
  put('demos', (Object.keys(names) as Demo[]).map((id) => btn('demo', id, names[id], demo === id)).join(''))
  put(
    'crumbs',
    labels
      .slice(0, depth + 1)
      .map(
        (name, i) =>
          (i ? icon('chevron', 11) : icon('layers', 14)) +
          '<button data-action="level" data-value="' +
          levels[i] +
          '"' +
          (i === depth ? ' aria-current="location"' : '') +
          '>' +
          name +
          '</button>'
      )
      .join('')
  )
  const navLoc =
    loc.level === 'gate' && loc.unit === 'lut' && loc.muxIndex === undefined
      ? { ...loc, muxIndex: (snapshot.luts[loc.bit]?.address ?? 0) >> (loc.tier ?? 1) }
      : loc
  tree.sync(family, chosen?.id ?? resourceIdFor(family, navLoc, graph?.probes[probeIndex]?.id))
  put('tree-summary', f.name + ' · 完整模块树')
  const legend =
    loc.level === 'chip'
      ? [
          [f.block, '#91c99c'],
          [f.ram, '#a896cb'],
          ['DSP', '#d5a76d'],
          ['时钟', '#7ba9c6'],
          ['I/O', '#b9b7a0']
        ]
      : loc.level === 'gate'
        ? [
            ['输入 / 输出', '#a1b7b8'],
            ['逻辑门', '#78ac8f']
          ]
        : [
            ['LUT', '#83be9e'],
            ['寄存器', '#aa99c9'],
            ['进位', '#d5a76d']
          ]
  put(
    'legend',
    legend
      .map(([label, color]) => '<span><i style="background:' + color + '"></i>' + label + '</span>')
      .join('') +
      '<small>' +
      (loc.level === 'gate' ? '功能等效电路' : '架构示意') +
      '</small>'
  )
}
const metric = (value: string, name: string) =>
  '<div><strong>' + value + '</strong><span>' + name + '</span></div>'
function detail() {
  const f = families[family],
    unit = unitLabels(family)[loc.unit]
  const configured =
    (!loc.block || loc.block === sampleBlock(family)) &&
    loc.bit < snapshot.usedBits &&
    loc.unit !== 'mux' &&
    (loc.unit !== 'ff' || (demo === 'counter' && !loc.secondaryFF)) &&
    (loc.unit !== 'carry' || demo !== 'xor')
  let title = '',
    desc = '',
    metrics = '',
    choices = '',
    next = ''
  if (chosen?.inspect) {
    const r = chosen.inspect
    put(
      'insight',
      '<div class="insight"><div class="field-label">模块详情</div><h3>' +
        r.name +
        '</h3><p>' +
        r.description +
        '</p></div>'
    )
    return
  }
  if (loc.level === 'chip') {
    title = f.name
    desc = '沿高亮的' + f.blockName + '进入芯片，查看 Slice 与内部信号通路。'
    metrics = metric(String(f.slices), 'Slice / ' + f.block) + metric('LUT' + f.width, '查找表类型')
    next = '展开 ' + f.block
  } else if (loc.level === 'block') {
    title = f.block + ' ' + (loc.block ?? sampleBlock(family))
    desc =
      family === 'amd'
        ? '这组 CLB 包含 SLICEM 与 SLICEL，各自具有独立的进位通道。'
        : '4 个 Slice 通过局部互连协作。快速进位可以从低位 Slice 进入相邻 Slice。'
    choices =
      '<div class="choice-row">' +
      Array.from({ length: f.slices }, (_, i) =>
        btn('slice', String(i), 'Slice ' + i, loc.slice === i)
      ).join('') +
      '</div>'
    next = '进入 Slice ' + loc.slice
  } else if (loc.level === 'slice') {
    title = 'Slice ' + loc.slice + (family === 'amd' ? ' · ' + (loc.slice === 0 ? 'SLICEM' : 'SLICEL') : '')
    desc =
      '含 ' + f.lanes + ' 个 LUT' + f.width + '、' + f.registers + ' 个存储单元，以及选择器和专用进位逻辑。'
    choices =
      '<div class="choice-row">' +
      (['lut', 'carry', 'ff', 'mux'] as Unit[])
        .map((u) => btn('unit', u, unitLabels(family)[u], loc.unit === u))
        .join('') +
      '</div>'
    next = '展开 ' + unit
  } else if (loc.level === 'unit') {
    title =
      loc.muxName && loc.unit === 'mux'
        ? loc.muxName + ' MUX'
        : unit + (loc.unit === 'mux' ? '' : ' · 位 ' + loc.bit)
    if (loc.unit === 'ff' && loc.secondaryFF) title = '辅助寄存器 ' + 'ABCD'[loc.bit % 4] + '5FF'
    if (loc.unit === 'lut') {
      desc =
        '每个配置位保存一个真值。地址输入逐级控制选择器，从 ' + (1 << f.width) + ' 个配置位中读出一位。'
      const lut = configured ? snapshot.luts[loc.bit] : undefined
      metrics = lut
        ? metric(binary(lut.address, f.width), '当前地址') + metric(String(lut.result), '读出值')
        : metric(String(1 << f.width), '配置位') + metric(String(f.width), '选择层数')
    } else if (loc.unit === 'ff') {
      desc = '时钟为低时主锁存器跟随有效 D。上升沿关闭主锁存器，从锁存器将采样结果传到 Q。'
    } else if (loc.unit === 'carry') {
      desc = '每位根据传播信号 P 选择进位，同时将 P 与输入进位异或得到和位。选择任一位可查看等效门。'
      choices =
        '<div class="choice-row">' +
        Array.from({ length: f.lanes }, (_, i) => i + loc.slice * f.lanes)
          .map((n) => btn('lane', String(n), '位 ' + n, n === loc.bit))
          .join('') +
        '</div>'
    } else desc = '专用选择器把多个 LUT 的结果组合成更宽的逻辑函数。'
    next = '查看等效逻辑门'
  } else if (graph) {
    title = graph.title
    const focused = graph.probes[probeIndex]
    desc =
      loc.unit === 'ff'
        ? '有效 D 综合了使能和同步清零。沿 NAND 门追踪主从锁存器的反馈。'
        : '点击门体或使用单步，查看选中门的输入与输出。'
    if (loc.unit === 'lut') {
      const tier = loc.tier ?? 1
      const index = loc.muxIndex ?? (snapshot.luts[loc.bit]?.address ?? 0) >> tier
      desc =
        '第 ' +
        tier +
        ' 层的 MUX[' +
        index +
        '] 由地址位 I' +
        (tier - 1) +
        ' 选通。逐门查看两条输入支路如何合并。'
    }
    if (focused) {
      const val = (id: string) => graph?.values[id] ?? '–'
      choices =
        '<div class="probe"><label>门级探针<select data-setting="probe" aria-label="门级探针">' +
        graph.probes
          .map(
            (p, i) =>
              '<option value="' +
              i +
              '"' +
              (i === probeIndex ? ' selected' : '') +
              '>' +
              p.name +
              ' · ' +
              p.op +
              '</option>'
          )
          .join('') +
        '</select></label><code>' +
        focused.inputs.map(val).join(' , ') +
        '　→　' +
        val(focused.id) +
        '</code></div>'
    }
  }
  if (loc.block && loc.block !== sampleBlock(family)) desc += ' 该逻辑块在本例中空闲。'
  const status =
    (loc.level === 'unit' || loc.level === 'gate') && !configured
      ? '<p class="inactive-note">当前示例未占用此资源</p>'
      : ''
  const button = next
    ? '<button class="drill" data-action="deeper">' + icon('inspect', 15) + next + '</button>'
    : ''
  put(
    'insight',
    '<div class="insight"><div class="field-label">模块详情</div><h3>' +
      title +
      '</h3><p>' +
      desc +
      '</p>' +
      status +
      (metrics ? '<div class="metrics">' + metrics + '</div>' : '') +
      choices +
      button +
      '</div>'
  )
}
function bitRow(name: 'A' | 'B', value: number, width: number) {
  return (
    '<div class="bit-row"><span class="port-name">' +
    name +
    '</span><div class="bits">' +
    Array.from({ length: width }, (_, i) => width - 1 - i)
      .map(
        (n) =>
          '<button data-action="bit" data-value="' +
          name +
          n +
          '" aria-label="切换 ' +
          name +
          n +
          '" aria-pressed="' +
          Boolean(bit(value, n)) +
          '" class="bit ' +
          (bit(value, n) ? 'on' : '') +
          '">' +
          bit(value, n) +
          '</button>'
      )
      .join('') +
    '</div><small>' +
    (width === 4 ? value : '输入 ' + name) +
    '</small></div>'
  )
}
const descTitle = (name: string, small = '') =>
  '<h3 class="section-label">' + name + (small ? '<small>' + small + '</small>' : '') + '</h3>'
function timeAxis(samples: Sample[], left: number, right: number, lookAhead = 0) {
  const start = samples[0].t
  const span = Math.max(1 / hz, samples.at(-1)!.t - start + lookAhead)
  return (t: number) => left + ((t - start) / span) * (right - left)
}
function clockTrace(samples: Sample[], x: (t: number) => number, high: number, low: number) {
  let path = `M${x(samples[0].t)} ${samples[0].clk ? high : low}`
  for (const sample of samples.slice(1)) path += `H${x(sample.t)}V${sample.clk ? high : low}`
  return path
}
function wave(samples: Sample[]) {
  const view = samples.slice(-12),
    first = view[0],
    last = view.at(-1)!
  const x = timeAxis(view, 26, 246)
  const cursor = x(last.t)
  let content = ''
  for (const [i, sample] of view.entries())
    if (i > 0 && sample.clk && !view[i - 1].clk)
      content += `<path d="M${x(sample.t)} 4v60" stroke="#58747b" stroke-dasharray="2 3"/>`
  for (const [row, key] of (['clk', 'd', 'q'] as const).entries()) {
    const y = 5 + row * 21,
      color = ['#88c8d2', '#c2a1dc', '#bce87b'][row]
    content += `<text x="1" y="${y + 8}" fill="${color}">${key.toUpperCase()}</text>`
    if (key === 'clk') {
      content += `<path d="${clockTrace(view, x, y, y + 10)}h3" stroke="${color}"/>`
    } else {
      let begin = first
      const bus = (end: number, transition: boolean) => {
        const start = x(begin.t),
          inset = transition ? Math.min(3, (end - start) / 2) : 0
        const from = start + inset
        let d = `M${from} ${y}H${end}M${from} ${y + 12}H${end}`
        if (transition) d += `M${start} ${y}l${inset} 12m-${inset} 0l${inset} -12`
        content += `<path d="${d}" stroke="${color}"/>`
        if (end - from > 29)
          content += `<text x="${(from + end) / 2}" y="${y + 9}" text-anchor="middle" fill="${color}">${binary(begin[key])}</text>`
      }
      for (const next of view.slice(1)) {
        if (next[key] === begin[key]) continue
        bus(x(next.t), begin !== first)
        begin = next
      }
      bus(cursor + 4, begin !== first)
    }
    const value = key === 'clk' ? String(last.clk) : binary(last[key])
    content += `<text x="286" y="${y + 9}" text-anchor="end" fill="${color}">${value}</text>`
  }
  content += `<text x="26" y="77" fill="#a6b8b0">${first.t} s</text>`
  if (cursor > 64)
    content += `<text x="${cursor}" y="77" text-anchor="end" fill="#a6b8b0">${last.t} s</text>`
  return `<svg class="wave" viewBox="0 0 290 80" role="img" aria-label="CLK、D 和 Q 的采样波形"><g fill="none" stroke-width="1.25">${content}</g></svg>`
}
function simulationPanel(s: Snapshot) {
  const input = inputs[demo],
    v = s.values
  const kind = demo === 'counter' ? '寄存器采样时钟' : '组合逻辑参考时钟'
  const period = 1 / hz
  const view = history.slice(-20),
    last = view.at(-1)!,
    x = timeAxis(view, 2, 207, period)
  const path = clockTrace(view, x, 3, 16)
  const nextEdge = last.t + ((2 - (timing.phase % 2)) * period) / 4
  const forecast = `M${x(last.t)} ${last.clk ? 3 : 16}H${x(nextEdge)}V${last.clk ? 16 : 3}H${x(nextEdge + period / 2)}V${last.clk ? 3 : 16}H${x(last.t + period)}`
  const options = [0.125, 0.25, 0.5, 1]
    .map((f) => `<option value="${f}" ${hz === f ? 'selected' : ''}>${f} Hz</option>`)
    .join('')
  put(
    'clock-panel',
    `<div class="clock-top"><strong>${icon('pulse', 15)}时钟 CLK</strong><span class="clock-role">${kind}</span></div>
    <div class="clock-stats"><b>${clock.clk ? '高 · 1' : '低 · 0'}</b><label>虚拟频率 <select id="clock-hz" aria-label="虚拟时钟频率">${options}</select></label><span>周期 ${period} s</span><span>${timing.last}</span><span>上升沿 ${timing.rises}</span><span>t = ${timing.elapsed} s</span></div>
    <div class="clock-bottom"><svg viewBox="0 0 210 19" preserveAspectRatio="none" role="img" aria-label="${kind}波形，实线为时钟记录，虚线为下个周期"><title>实线为时钟记录，虚线为下个周期</title><path d="${forecast}" stroke="#638399" stroke-width="1.3" stroke-dasharray="3 3" fill="none" vector-effect="non-scaling-stroke"/><path d="${path}" stroke="#76bbf0" stroke-width="1.7" fill="none" vector-effect="non-scaling-stroke"/><circle cx="${x(last.t)}" cy="${last.clk ? 3 : 16}" r="1.6" fill="#9cdaff"/></svg><button data-action="clock" class="clock-btn">${clock.clk ? '推进至下降沿' : '推进至上升沿'}</button></div>`
  )
  if (demo === 'counter') {
    put(
      'inputs',
      descTitle('寄存器控制') +
        '<div class="control-signals">' +
        btn('en', '', '使能 EN <b>' + Number(input.en) + '</b>', input.en) +
        btn('rst', '', '清零 RST <b>' + Number(input.reset) + '</b>', input.reset) +
        '</div>'
    )
  } else
    put(
      'inputs',
      descTitle('输入信号', demo === 'adder' ? 'MSB → LSB' : '') +
        bitRow('A', input.a, demo === 'xor' ? 1 : 4) +
        bitRow('B', input.b, demo === 'xor' ? 1 : 4)
    )
  const output = demo === 'xor' ? String(v.Y) : binary(demo === 'adder' ? v.SUM : v.Q)
  const eq = demo === 'xor' ? 'Y = A ⊕ B' : demo === 'adder' ? 'SUM = A + B' : 'D = (Q + 1) mod 16'
  const extra =
    demo === 'adder' ? 'C4 = ' + v.C4 : demo === 'counter' ? 'D = ' + binary(v.D) + '　CLK = ' + v.CLK : ''
  put(
    'readout',
    descTitle('输出信号') +
      '<div class="output"><span>' +
      (demo === 'xor' ? 'Y' : demo === 'adder' ? 'SUM' : 'Q') +
      '</span><strong>' +
      output +
      '</strong></div><div class="equation">' +
      eq +
      '</div>' +
      (extra ? '<div class="extra-value">' + extra + '</div>' : '')
  )
  if (demo === 'xor') {
    let rows = ''
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++)
        rows +=
          '<tr class="' +
          (a === input.a && b === input.b ? 'hot-row' : '') +
          '"><td>' +
          a +
          '</td><td>' +
          b +
          '</td><td>' +
          (a ^ b) +
          '</td></tr>'
    put(
      'evidence',
      descTitle('异或真值表') +
        '<table class="data-table"><thead><tr><th>A</th><th>B</th><th>Y</th></tr></thead><tbody>' +
        rows +
        '</tbody></table>'
    )
  } else if (demo === 'adder') {
    let rows = ''
    for (let n = 0; n < 4; n++)
      rows +=
        '<tr class="' +
        (step === n + 1 ? 'hot-row' : '') +
        '"><td>' +
        n +
        '</td><td>' +
        v['P' + n] +
        '</td><td>' +
        v['C' + n] +
        '</td><td>' +
        v['S' + n] +
        '</td><td>' +
        v['C' + (n + 1)] +
        '</td></tr>'
    put(
      'evidence',
      descTitle('逐位进位') +
        '<table class="data-table"><thead><tr><th>位</th><th>P</th><th>Cin</th><th>Sum</th><th>Cout</th></tr></thead><tbody>' +
        rows +
        '</tbody></table>'
    )
  } else put('evidence', descTitle('时序波形', '上升沿采样') + wave(history))
  put('play', icon(playing ? 'pause' : 'play', 15) + (playing ? '暂停' : '播放'))
  const stepButton = document.querySelector<HTMLButtonElement>('[data-action="step"]')!
  stepButton.disabled =
    demo !== 'counter' && step === s.phases.length - 1 && !(graph && probeIndex < graph.probes.length - 1)
  const p = s.phases[step]
  put(
    'timeline',
    '<div class="step-label"><span class="step-index">' +
      String(step + 1).padStart(2, '0') +
      ' / ' +
      String(s.phases.length).padStart(2, '0') +
      '</span><b>' +
      p.name +
      '</b></div><div class="segments">' +
      s.phases
        .map((ph, i) => '<i title="' + ph.name + '" class="' + (i <= step ? 'filled' : '') + '"></i>')
        .join('') +
      '</div><p>' +
      p.detail +
      '</p>'
  )
}
function render() {
  snapshot = simulate(family, demo, inputs[demo], clock)
  const occupied = !loc.block || loc.block === sampleBlock(family) || loc.level === 'chip'
  const view: Snapshot = occupied ? snapshot : { ...snapshot, values: {}, luts: [], usedBits: 0 }
  graph = loc.level === 'gate' ? gateGraph(view, loc) : undefined
  if (loc.probe && graph) {
    const i = graph.probes.findIndex((p) => p.id === loc.probe)
    if (i >= 0) probeIndex = i
    loc.probe = undefined
  }
  if (graph) probeIndex = Math.min(probeIndex, graph.probes.length - 1)
  const probe = graph?.probes[probeIndex]
  const sceneContext = [loc.level, loc.level === 'unit' || loc.level === 'gate' ? loc.unit : ''].join('/')
  const focusBit = loc.level === 'chip' || loc.level === 'block' ? '' : loc.bit
  const addr = loc.level === 'unit' && loc.unit === 'lut' ? snapshot.luts[loc.bit]?.address : ''
  const key = [
    sceneContext,
    family,
    demo,
    loc.slice,
    focusBit,
    addr,
    loc.tier,
    loc.muxIndex,
    loc.secondaryFF,
    loc.muxName,
    loc.block,
    chosen?.inspect ? chosen.id : ''
  ].join('/')
  if (stage && key !== assetKey) {
    const asset =
      loc.level === 'chip'
        ? buildChip(family, demo)
        : loc.level === 'block'
          ? buildBlock(family, demo, loc)
          : loc.level === 'slice'
            ? buildSlice(family, demo, loc)
            : loc.level === 'unit'
              ? buildUnit(view, loc)
              : buildGates(graph!)
    if (loc.level === 'chip') chipResources(asset, family, chosen)
    netNames = Array.from(new Set(asset.routes.map((r) => r.signal))).filter(
      (n) => !n.startsWith('unused-') && !n.startsWith('idle')
    )
    if (!netNames.includes(solo)) solo = ''
    stage.show(asset, sceneContext === contextKey)
    assetKey = key
    contextKey = sceneContext
  }
  const phase = snapshot.phases[step]
  const hot = probe ? [...probe.inputs, probe.id] : [...phase.active]
  if (loc.level === 'unit' && loc.unit === 'lut' && view.luts[loc.bit])
    hot.push(...view.luts[loc.bit].selected)
  stage?.update(graph ? { ...view.values, ...graph.values } : view.values, hot, playing, speed, solo)
  const wire = wirePanel(netNames, solo, hot, view, loc, graph)
  put('net-count', wire.count)
  put('wire-controls', wire.controls)
  put('wire-detail', wire.detail)
  nav()
  detail()
  simulationPanel(snapshot)
}
function advance() {
  if (graph && probeIndex < graph.probes.length - 1) {
    probeIndex++
    chosen = undefined
    return
  }
  if (step === snapshot.phases.length - 1 && demo !== 'counter') {
    stop()
    return
  }
  probeIndex = 0
  step = (step + 1) % snapshot.phases.length
  clockQuarters(1)
  if (demo === 'counter') step = timing.phase
  if (
    demo === 'adder' &&
    (!loc.block || loc.block === sampleBlock(family)) &&
    step >= 1 &&
    step <= 4 &&
    loc.bit < 4 &&
    loc.level !== 'gate'
  ) {
    if (chosen?.jump) chosen = undefined
    loc.bit = step - 1
    loc.slice = Math.floor(loc.bit / families[family].lanes)
  }
  if (step === snapshot.phases.length - 1 && demo !== 'counter' && !graph) stop()
}
function schedule() {
  clearTimeout(timer)
  if (playing)
    timer = setTimeout(
      () => {
        advance()
        render()
        schedule()
      },
      1000 / (4 * hz * speed)
    )
}
function restart(run: boolean) {
  stop()
  step = 0
  probeIndex = 0
  timing = startTiming()
  clock = timing.clock
  history = []
  record()
  playing = run
  render()
  schedule()
}
function changeFamily(id: Family) {
  if (id === family) return
  family = id
  chosen = undefined
  solo = ''
  loc.block = sampleBlock(family)
  loc.slice = Math.floor(loc.bit / families[family].lanes)
  loc.secondaryFF = false
  loc.muxName = undefined
  if (loc.tier && loc.tier > families[family].width) {
    loc.tier = families[family].width
    loc.muxIndex = 0
  }
  if (loc.tier && loc.muxIndex !== undefined)
    loc.muxIndex = Math.min(loc.muxIndex, (1 << (families[family].width - loc.tier)) - 1)
  render()
}
function changeDemo(id: Demo) {
  if (id === demo) return
  demo = id
  chosen = undefined
  solo = ''
  loc = { level: loc.level, bit: 0, slice: 0, unit: id === 'xor' ? 'lut' : id === 'adder' ? 'carry' : 'ff' }
  restart(false)
}
function deeper() {
  const next = levels[levels.indexOf(loc.level) + 1]
  if (next) navigate({ level: next })
}
document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
  if (!b) return
  const act = b.dataset.action,
    val = b.dataset.value ?? ''
  switch (act) {
    case 'family':
      changeFamily(val as Family)
      break
    case 'demo':
      changeDemo(val as Demo)
      break
    case 'level':
      navigate({ level: val as Level })
      break
    case 'deeper':
      deeper()
      break
    case 'slice':
      navigate({ level: 'slice', slice: Number(val) })
      break
    case 'unit':
      navigate({ level: 'unit', unit: val as Unit })
      break
    case 'lane':
      navigate({ level: 'unit', bit: Number(val) })
      break
    case 'bit': {
      stop()
      const key = val[0] === 'A' ? 'a' : 'b'
      inputs[demo][key] ^= 1 << Number(val.slice(1))
      step = 0
      probeIndex = 0
      render()
      break
    }
    case 'en':
    case 'rst': {
      stop()
      const key = act === 'en' ? 'en' : 'reset'
      inputs.counter[key] = !inputs.counter[key]
      render()
      break
    }
    case 'wire':
      solo = val
      render()
      break
    case 'clock':
      stop()
      clockQuarters(2 - (timing.phase % 2))
      if (demo === 'counter') step = timing.phase
      render()
      break
    case 'play':
      if (playing) {
        stop()
        render()
      } else if (
        step === snapshot.phases.length - 1 &&
        demo !== 'counter' &&
        (!graph || probeIndex === graph.probes.length - 1)
      ) {
        restart(true)
      } else {
        playing = true
        render()
        schedule()
      }
      break
    case 'step':
      stop()
      advance()
      render()
      break
    case 'restart':
      restart(true)
      break
    case 'home':
      stage?.home()
      break
    case 'zoom-in':
      stage?.zoom(1.2)
      break
    case 'zoom-out':
      stage?.zoom(1 / 1.2)
      break
    case 'expand': {
      const full = get('viewport').classList.toggle('expanded')
      document.body.classList.toggle('locked', full)
      b.setAttribute('aria-pressed', String(full))
      b.setAttribute('aria-label', full ? '收起视窗' : '展开视窗')
      break
    }
    case 'docs':
      ;(get('docs') as HTMLDialogElement).showModal()
      break
    case 'close-docs':
      ;(get('docs') as HTMLDialogElement).close()
      break
  }
})
document.addEventListener('change', (e) => {
  const t = e.target as HTMLSelectElement
  if (t.id === 'clock-hz') {
    hz = Number(t.value)
    render()
    schedule()
  }
  if (t.dataset.setting === 'wire') {
    solo = t.value
    render()
  }
  if (t.id === 'speed') {
    speed = Number(t.value)
    render()
    schedule()
  }
  if (t.dataset.setting === 'probe') {
    chosen = undefined
    stop()
    probeIndex = Number(t.value)
    render()
  }
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && get('viewport').classList.contains('expanded'))
    document.querySelector<HTMLButtonElement>('[data-action="expand"]')?.click()
})
get('docs').addEventListener('click', (e) => {
  if (e.target === get('docs')) (get('docs') as HTMLDialogElement).close()
})
window.addEventListener('pagehide', (e) => {
  if (!e.persisted) {
    stop()
    stage?.dispose()
  }
})
render()
