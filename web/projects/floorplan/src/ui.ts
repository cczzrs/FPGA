import { closest, type Bit, type Module, type Port } from './model/cells.ts'
import { getDesign } from './model/index.ts'
import { display, displayPort, propagate, selection, type Result, type Shown } from './model/sim.ts'
import { ARCHES, ARCH_NAME, at, EXAMPLES, EXAMPLE_NAME, type Arch, type Example } from './model/stages.ts'
import { activeStages, isUsed } from './scene/activity.ts'
import { SPEEDS, type Sample, type Session } from './session.ts'
import { SOURCES } from './sources.ts'

const TEXT: Record<string, string> = { '0': '0', '1': '1', pending: '·', unused: '—' }
const SPOKEN: Record<string, string> = { '0': '0', '1': '1', pending: '未到达', unused: '未使用' }
const HIGH_TO_LOW = [3, 2, 1, 0] as const
const EQUIVALENT = new Set(['lut', 'carrybit', 'ccu', 'adder', 'xor', 'mux', 'ff', 'latch', 'select', 'switch'])

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing FPGA Floorplan element: #${id}`)
  return element as T
}
const word = (value: number | null) => (value === null ? '····' : value.toString(2).padStart(4, '0'))

function chip(value: Shown): string {
  return `<span class="value" data-value="${value}" title="${SPOKEN[value]}">${TEXT[value]}</span>`
}

/** 内容没变就不写 DOM；重写时保住键盘焦点和折叠状态。 */
function render(element: HTMLElement, html: string): void {
  if (rendered.get(element) === html) return
  rendered.set(element, html)
  const active = document.activeElement as HTMLElement | null
  const focused = active && element.contains(active) ? active.dataset.f : undefined
  const open = new Set([...element.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.dataset.d))
  element.innerHTML = html
  for (const details of element.querySelectorAll<HTMLDetailsElement>('details')) details.open = open.has(details.dataset.d)
  if (focused) element.querySelector<HTMLElement>(`[data-f="${focused}"]`)?.focus({ preventScroll: true })
}
const rendered = new WeakMap<HTMLElement, string>()

const shortName = (module: Module) => module.name.split(' · ')[0]!
const openButton = (module: Module, text: string, key: string) =>
  `<button type="button" class="link" data-open="${module.id}" data-f="${key}">${text}</button>`

export class UI {
  private session: Session
  private inputsFor: Example | null = null
  private infoFor = ''

  constructor(session: Session, resetView: () => void) {
    this.session = session
    render($('arches'), ARCHES.map((a) => `<button type="button" data-arch="${a}">${ARCH_NAME[a]}</button>`).join(''))
    render($('examples'), EXAMPLES.map((e) => `<button type="button" data-example="${e}">${EXAMPLE_NAME[e]}</button>`).join(''))
    render($('speed'), SPEEDS.map((s) => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s}×</option>`).join(''))
    render($('sources'), SOURCES.map(({ title, url, use }) => {
      const name = url ? `<a href="${url}" target="_blank" rel="noreferrer">${title}</a>` : `<em>${title}</em>`
      return `<li>${name}<span>${use}</span></li>`
    }).join(''))

    document.addEventListener('click', (event) => {
      const target = (event.target as Element).closest<HTMLElement>('[data-arch], [data-example], [data-open], [data-input]')
      if (!target) return
      event.preventDefault()
      const { arch, example, open, input } = target.dataset
      if (arch) session.setArch(arch as Arch)
      if (example) session.setExample(example as Example)
      if (open) session.open(open)
      if (input) session.setInput(input, (session.run.inputs[input]! ^ 1) as Bit)
    })
    $('play').addEventListener('click', () => (session.run.playing ? session.pause() : session.play()))
    $('step').addEventListener('click', () => session.step())
    $('replay').addEventListener('click', () => session.replay())
    $('clock').addEventListener('click', () => session.clockEdge())
    $('back').addEventListener('click', () => session.back())
    $('reset').addEventListener('click', resetView)
    $('locate').addEventListener('click', () => session.open(session.active.id))
    $('speed').addEventListener('change', (e) => session.setSpeed(Number((e.target as HTMLSelectElement).value)))
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) session.back()
    })
  }

  info(text: string): void {
    this.infoFor = this.session.focus
    $('info').textContent = text
  }

  progress(): void {
    const { stage, progress } = this.session.run
    const done = (stage + Math.min(progress, 1)) / this.session.stages.length
    $('progress').style.transform = `scaleX(${done})`
  }

  update(): void {
    const { session } = this
    const { example, arch, run } = session
    for (const b of document.querySelectorAll<HTMLElement>('#arches button')) b.setAttribute('aria-pressed', String(b.dataset.arch === arch))
    for (const b of document.querySelectorAll<HTMLElement>('#examples button')) b.setAttribute('aria-pressed', String(b.dataset.example === example))

    $('operate-title').textContent = EXAMPLE_NAME[example]
    this.inputs()
    render($('readout'), example === 'xor' ? this.truthTable() : example === 'adder' ? this.addition() : this.counter())
    this.transport()
    this.stage()
    this.lut()
    render($('compare'), this.compare())
    this.hierarchy()
    this.ports()
    if (this.infoFor !== session.focus) $('info').textContent = ''
    $('stage-text').setAttribute('aria-live', run.playing ? 'off' : 'polite')
    this.progress()
  }

  // ---------- 操作 ----------

  private inputs(): void {
    const { example, run } = this.session
    if (this.inputsFor !== example) {
      this.inputsFor = example
      const toggle = (name: string, label = name) =>
        `<button type="button" class="bit" data-input="${name}" data-f="${name}"><span>${label}</span><b></b></button>`
      const html = example === 'xor'
        ? `<div class="bits">${toggle('A')}${toggle('B')}</div>`
        : example === 'adder'
          ? ['A', 'B'].map((w) => `<div class="bits" role="group" aria-label="${w}[3:0]">${HIGH_TO_LOW.map((i) => toggle(`${w}${i}`)).join('')}</div>`).join('') +
            '<p class="muted">初始进位 C0 固定为 0。</p>'
          : `<div class="bits">${toggle('EN', 'EN 使能')}${toggle('CLR', 'CLR 同步清零')}</div><p class="muted">CLR 优先于 EN。两者都只在上升沿生效。</p>`
      render($('inputs'), html)
    }
    for (const button of $('inputs').querySelectorAll<HTMLElement>('[data-input]')) {
      const value = String(run.inputs[button.dataset.input!])
      button.querySelector('b')!.textContent = value
      button.dataset.value = value
      button.setAttribute('aria-pressed', String(value === '1'))
    }
  }

  private truthTable(): string {
    const { design, run, result } = this.session
    const lut = design.roles.get('lut:0')!
    const chosen = selection(result, lut)
    const pins = lut.ports.filter((p) => p.dir === 'in')
    const out = design.probes.lut![0]!
    const rows = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([a, b]) => {
      // 真值表逐行取自同一张门级网表。
      const values = propagate(design, { A: a as Bit, B: b as Bit }, {})
      const address = pins.reduce((sum, p, i) => sum + values[p.net]! * 2 ** i, 0)
      const current = !!chosen && run.inputs.A === a && run.inputs.B === b
      return `<tr class="${current ? 'current' : ''}"${current ? ' aria-current="true"' : ''}><td>${a}</td><td>${b}</td><td>INIT[${address}]</td><td>${values[out]}</td></tr>`
    })
    return `<p class="equation"><span>Y = A ⊕ B =</span>${chip(display(result, design.probes.out![0]!))}</p>
      <table class="truth"><caption>LUT 真值表</caption><thead><tr><th>A</th><th>B</th><th>配置位</th><th>Y</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
  }

  private bitTable(result: Result, names: [title: string, probe: string][]): string {
    const { design } = result
    const current = /^[psc](\d)$/.exec(this.session.stages[result.stage]!.id)?.[1]
    let previous: Module | null = null
    const rows = HIGH_TO_LOW.map((i) => {
      const carry = design.roles.get(`carry:${i}`)!
      const slice = closest(carry, 'slice')!
      const boundary = previous && previous !== slice
      previous = slice
      const cells = names.map(([, probe]) => `<td>${chip(display(result, design.probes[probe]![i]!))}</td>`).join('')
      return `<tr class="${boundary ? 'boundary ' : ''}${current === String(i) ? 'current' : ''}">
        <th scope="row">${openButton(carry, String(i), `bit-${i}`)}</th>${cells}<td class="owner">${openButton(slice, shortName(slice), `owner-${i}`)}</td></tr>`
    })
    return `<div class="scroll"><table class="per-bit"><caption>逐位数值，粗线是 Slice 边界</caption>
      <thead><tr><th>位</th>${names.map(([title]) => `<th>${title}</th>`).join('')}<th>所在</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
  }

  private addition(): string {
    const { run, result } = this.session
    const { probes } = result.design
    const operand = (w: string) => HIGH_TO_LOW.map((i) => run.inputs[`${w}${i}`]).join('')
    const sum = HIGH_TO_LOW.map((i) => TEXT[display(result, probes.sum![i]!)]).join('')
    return `<p class="equation"><span>${operand('A')} + ${operand('B')} =</span><strong id="sum">${sum}</strong></p>
      <p class="carry-out">最终进位 Cout ${chip(display(result, probes.exit![0]!))}</p>
      ${this.bitTable(result, [['A', 'a'], ['B', 'b'], ['进位入', 'cin'], ['P', 'p'], ['和', 'sum'], ['进位出', 'cout']])}`
  }

  private counter(): string {
    const { run, result } = this.session
    const { probes } = result.design
    const read = (probe: string) => HIGH_TO_LOW.map((i) => TEXT[display(result, probes[probe]![i]!)]).join('')
    const high = run.inputs.CLK === 1
    const sampling = this.session.stages[run.stage]!.id === 'rise'
    // 上升沿一过，采样值就锁在主锁存里，此后改输入也不影响它。
    const nextLabel = sampling ? '本沿已采样' : high ? '下个上升沿将采样' : '本沿将采样'
    return `<dl class="words">
        <div><dt>CLK</dt><dd id="clk-value">${chip(run.inputs.CLK!)}</dd></div>
        <div><dt>D = Q + 1</dt><dd id="d-value">${read('d')}</dd></div>
        <div><dt>${nextLabel}</dt><dd id="next-value">${read(sampling ? 'captured' : 'next')}</dd></div>
        <div><dt>Q 输出</dt><dd id="q-value">${read('q')}</dd></div>
      </dl>
      ${waveform(run.history)}
      ${this.bitTable(result, [['Q', 'q'], ['加数', 'b'], ['进位入', 'cin'], ['D', 'd'], ['进位出', 'cout']])}`
  }

  private transport(): void {
    const { session } = this
    const { run, example } = session
    $('play').textContent = run.playing ? '暂停' : example === 'counter' ? '连续播放' : '播放'
    $('stage-name').textContent = session.stages[run.stage]!.name
    $('stage-count').textContent = `${run.stage + 1} / ${session.stages.length}`
    const clock = $('clock')
    clock.hidden = example !== 'counter'
    clock.textContent = run.inputs.CLK === 1 ? 'CLK 推到 0 ↓' : 'CLK 推到 1 ↑'
  }

  private stage(): void {
    const { session } = this
    const stage = session.stages[session.run.stage]!
    $('stage-text').textContent = stage.text
    const active = session.active
    const chain: string[] = []
    for (let m: Module | null = active; m?.parent; m = m.parent) chain.unshift(shortName(m))
    render($('stage-hardware'), `承担此步：${openButton(active, chain.join(' › '), 'hardware')}`)

    // 已经身处负责的模块里，或它就在眼前时，不必再提示。
    const focus = session.focused
    let related = false
    for (let m: Module | null = active; m; m = m.parent) related ||= m === focus
    for (let m: Module | null = focus; m; m = m.parent) related ||= m === active
    const locate = $('locate')
    locate.hidden = related || activeStages(session.design, focus).has(session.run.stage)
    const slice = closest(active, 'slice')
    locate.textContent = `当前步骤在 ${slice ? shortName(slice) : active.name}`

    const badge = focus.kind === 'chip' ? '架构示意' : EQUIVALENT.has(focus.kind) ? '功能等效电路' : '逻辑结构示意 · 示例映射'
    $('badge').textContent = `${ARCH_NAME[session.arch]} · ${badge}`
  }

  private lut(): void {
    const { session } = this
    const lut = closest(session.focused, 'lut')
    $('lut-section').hidden = !lut
    if (!lut) return
    const pins = lut.ports.filter((p) => p.dir === 'in')
    const hex = lut.init!.toString(16).toUpperCase().padStart(2 ** pins.length / 4, '0')
    const chosen = selection(session.result, lut)
    const head = `<p>${lut.name}，INIT = <code>${hex}</code></p>`
    if (!chosen) {
      render($('lut'), `${head}<p class="muted">${isUsed(lut) ? '地址尚未到达。' : '本例未使用这个 LUT。'}</p>`)
      return
    }
    const address = chosen.address
    const branch = pins.map((p, i) => {
      const value = (address >> i) & 1
      return `<li><span>${p.name}</span>${chip(value as Bit)}<span>选 I${value}</span></li>`
    })
    render($('lut'), `${head}
      <p>地址 ${[...pins].reverse().map((p) => p.name).join(' ')} = <code>${address.toString(2).padStart(pins.length, '0')}</code>，选中 <strong id="selected-bit">INIT[${address}] = ${(lut.init! >> BigInt(address)) & 1n}</strong></p>
      <ol class="branch">${branch.join('')}</ol>`)
  }

  private compare(): string {
    const { session } = this
    return ARCHES.map((arch) => {
      const result = session.resultFor(arch)
      const design = getDesign(arch, session.example)
      let body: string
      if (session.example === 'xor') {
        const lut = design.roles.get('lut:0')!
        body = `<div class="lanes"><span class="lane"><small>${shortName(closest(lut, 'slice')!)} · LUT${lut.ports.filter((p) => p.dir === 'in').length}</small>
          <span>LUT 输出 ${chip(display(result, design.probes.lut![0]!))}</span></span></div>`
      } else {
        const groups = new Map<Module, number[]>()
        for (const i of HIGH_TO_LOW) {
          const slice = closest(design.roles.get(`carry:${i}`)!, 'slice')!
          groups.set(slice, [...(groups.get(slice) ?? []), i])
        }
        const lanes = [...groups].map(([slice, bits]) => `<span class="lane"><small>${shortName(slice)}</small><span class="cells">${
          bits.map((i) => `<span class="cell"><i>${i}</i>${chip(display(result, design.probes.sum![i]!))}</span>`).join('')
        }</span><small>进位入 ${chip(display(result, design.probes.cin![bits.at(-1)!]!))}</small></span>`)
        const aux = (role: string, title: string, net: () => number) => {
          const module = design.roles.get(role)
          const slice = module && closest(module, 'slice')!
          return slice?.aux ? `<span class="lane aux"><small>${role === 'exit' && arch === 'amd' ? '上方 CLB' : shortName(slice)}</small><span>${title}</span><small>${chip(display(result, net()))}</small></span>` : ''
        }
        body = `<div class="lanes">${aux('exit', '引出', () => design.probes.exit![0]!)}${lanes.join('')}${aux('cinit', '引入', () => design.probes.cin![0]!)}</div>`
      }
      return `<div class="arch-row${arch === session.arch ? ' current' : ''}">
        <button type="button" class="link" data-arch="${arch}" data-f="compare-${arch}">${ARCH_NAME[arch]}</button>${body}</div>`
    }).join('')
  }

  // ---------- 层级与端口 ----------

  private hierarchy(): void {
    const { session } = this
    const { design, result } = session
    const focus = session.focused
    const path: Module[] = []
    for (let m: Module | null = focus; m; m = m.parent) path.unshift(m)

    render($('crumbs'), path.map((m, i) =>
      `<li><a href="#" data-open="${m.id}" data-f="crumb-${i}"${m === focus ? ' aria-current="page"' : ''}>${m.kind === 'chip' ? m.name : shortName(m)}</a></li>`).join(''))
    ;($('back') as HTMLButtonElement).disabled = !focus.parent

    const node = (m: Module): string => {
      const current = m === focus
      const expanded = path.includes(m)
      let children = ''
      if (expanded) {
        let list = m.children.filter((c) => c.children.length)
        let folded: Module[] = []
        if (m.kind === 'lut') {
          const chosen = selection(result, m)
          list = list.filter((c) => path.includes(c) || (chosen ? chosen.path.has(c) : c.key.endsWith('_0')))
        } else if (m.kind === 'chip') {
          folded = list.filter((c) => c.kind === 'switch' && !path.includes(c))
          list = list.filter((c) => c.kind !== 'switch' || path.includes(c))
        }
        const more = folded.length
          ? `<li><details data-d="switches"><summary>互连开关（${folded.length}）</summary><ul>${folded.map(node).join('')}</ul></details></li>`
          : ''
        if (list.length || more) children = `<ul>${list.map(node).join('')}${more}</ul>`
      }
      const unused = m.kind !== 'chip' && !isUsed(m)
      return `<li><button type="button" class="node${unused ? ' unused' : ''}" data-open="${m.id}" data-f="tree-${m.id}"${current ? ' aria-current="true"' : ''}>${m.name}</button>${children}</li>`
    }
    render($('tree'), `<ul>${node(design.root)}</ul>`)
  }

  private ports(): void {
    const { session } = this
    const { design, result } = session
    const focus = session.focused
    const list = focus.kind === 'chip'
      ? focus.children.filter((c) => c.kind === 'pad').map((pad): Port => ({ ...pad.ports[0]!, name: pad.name, dir: pad.ports[0]!.dir === 'out' ? 'in' : 'out' }))
      : focus.ports
    const row = (p: Port) => {
      const constant = design.nets[p.net]!.constant !== undefined
      return `<li><code>${p.name}</code><span class="muted">${p.dir === 'in' ? '入' : '出'}${constant && p.used ? ' · 常量' : ''}</span>${chip(displayPort(result, p))}</li>`
    }
    const used = list.filter((p) => p.used)
    const unused = list.filter((p) => !p.used)
    render($('ports'), `${used.length ? `<ul class="ports">${used.map(row).join('')}</ul>` : '<p class="muted">本例未使用这个模块。</p>'}${
      unused.length ? `<details data-d="unused"><summary>未使用端口（${unused.length}）</summary><ul class="ports">${unused.map(row).join('')}</ul></details>` : ''}`)
  }
}

// ---------- 波形 ----------

const WAVE = { width: 348, label: 44, row: 25, span: 17.6 }

function weight(stage: number): number {
  if (stage === at('counter', 'ready') || stage === at('counter', 'fall')) return 1.2
  return stage === at('counter', 'high') ? 1 : stage === 0 ? 0.8 : 0.5
}

/** 只画已经发生的采样，不预画后面的阶段。 */
function waveform(history: Sample[]): string {
  let start = history.length
  let total = 0
  while (start > 0 && total + weight(history[start - 1]!.stage) <= WAVE.span) total += weight(history[--start]!.stage)
  const shown = history.slice(start)
  const scale = (WAVE.width - WAVE.label - 4) / WAVE.span
  const xs: number[] = [WAVE.label]
  for (const sample of shown) xs.push(xs.at(-1)! + weight(sample.stage) * scale)

  const line = (key: 'clk' | 'en' | 'clr', row: number) => {
    const y = (value: number) => (row + 1) * WAVE.row - 5 - value * (WAVE.row - 10)
    let path = ''
    shown.forEach((s, i) => {
      path += `${i ? 'L' : 'M'}${xs[i]!.toFixed(1)},${y(s[key])} L${xs[i + 1]!.toFixed(1)},${y(s[key])} `
    })
    return `<path class="signal ${key}" d="${path}"/>`
  }
  const bus = (key: 'd' | 'q', row: number) => {
    const top = row * WAVE.row + 4
    const bottom = top + WAVE.row - 8
    const middle = (top + bottom) / 2
    let html = ''
    for (let i = 0; i < shown.length;) {
      let j = i + 1
      while (j < shown.length && shown[j]![key] === shown[i]![key]) j++
      const a = xs[i]!
      const b = xs[j]!
      const value = shown[i]![key]
      const bevel = Math.min(3, (b - a) / 2)
      html += `<path class="bus ${key}${value === null ? ' unknown' : ''}" d="M${a},${middle} L${a + bevel},${top} H${b - bevel} L${b},${middle} L${b - bevel},${bottom} H${a + bevel} Z"/>`
      if (b - a >= 32) html += `<text x="${(a + b) / 2}" y="${middle + 4}" text-anchor="middle">${word(value)}</text>`
      i = j
    }
    return html
  }
  const names = ['CLK', 'EN', 'CLR', 'D', 'Q']
  const now = xs.at(-1)!
  const last = shown.at(-1)!
  return `<svg class="wave" viewBox="0 0 ${WAVE.width} ${names.length * WAVE.row}" role="img"
      aria-label="波形，最新一点：CLK=${last.clk}，EN=${last.en}，CLR=${last.clr}，D=${word(last.d)}，Q=${word(last.q)}" data-samples="${history.length}">
    ${names.map((name, i) => `<text class="name" x="0" y="${(i + 0.5) * WAVE.row + 4}">${name}</text>`).join('')}
    ${line('clk', 0)}${line('en', 1)}${line('clr', 2)}${bus('d', 3)}${bus('q', 4)}
    <path class="now" d="M${now},1 V${names.length * WAVE.row - 1}"/>
  </svg>`
}
