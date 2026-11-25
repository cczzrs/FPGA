import { closest, type Bit, type Design, type Kind, type Module } from './model/cells.ts'
import { getDesign } from './model/index.ts'
import { display, propagate, readWord, settle, type Inputs, type Registers, type Result } from './model/sim.ts'
import { at, EXAMPLES, STAGES, type Arch, type Example } from './model/stages.ts'

export interface Sample {
  stage: number
  clk: Bit
  en: Bit
  clr: Bit
  d: number | null
  q: number
}

interface Checkpoint {
  regs: Registers
  history: Sample[]
  cycle: number
}

export interface Run {
  inputs: Inputs
  regs: Registers
  stage: number
  /** 当前阶段内的动画进度。它只影响光点，不影响读值。 */
  progress: number
  playing: boolean
  cycle: number
  history: Sample[]
  checkpoint: Checkpoint
}

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const
const STAGE_SECONDS = 1.1
const HISTORY_LIMIT = 240
const READY = at('counter', 'ready')
const RISE = at('counter', 'rise')
const UPDATE = at('counter', 'update')
const HIGH = at('counter', 'high')
const FALL = at('counter', 'fall')

function bits(prefix: string, value: number): Inputs {
  return Object.fromEntries([0, 1, 2, 3].map((i) => [`${prefix}${i}`, ((value >> i) & 1) as Bit]))
}

const DEFAULT_INPUTS: Record<Example, () => Inputs> = {
  xor: () => ({ A: 1, B: 0 }),
  adder: () => ({ ...bits('A', 0b0111), ...bits('B', 0b0001) }),
  counter: () => ({ CLK: 0, EN: 1, CLR: 0 }),
}

export class Session {
  arch: Arch = 'amd'
  example: Example = 'xor'
  speed = 1
  focus = 'chip'
  runs: Record<Example, Run>
  private listeners = new Set<() => void>()
  private cached: Result | null = null

  constructor() {
    this.runs = Object.fromEntries(EXAMPLES.map((e) => [e, createRun(e)])) as Record<Example, Run>
  }

  get run(): Run {
    return this.runs[this.example]
  }

  get design(): Design {
    return getDesign(this.arch, this.example)
  }

  get stages() {
    return STAGES[this.example]
  }

  get finished(): boolean {
    return this.example !== 'counter' && this.run.stage === this.stages.length - 1
  }

  get focused(): Module {
    return this.design.modules.get(this.focus) ?? this.design.root
  }

  /** 当前阶段在本架构里由哪个模块承担。 */
  get active(): Module {
    return this.design.roles.get(this.stages[this.run.stage]!.role)!
  }

  get result(): Result {
    return (this.cached ??= this.resultFor(this.arch))
  }

  /** 同一份状态在任一架构上的结果，供并排对照。 */
  resultFor(arch: Arch): Result {
    const design = getDesign(arch, this.example)
    const { inputs, regs, stage } = this.run
    return { design, stage, values: propagate(design, inputs, regs) }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    this.cached = null
    for (const listener of this.listeners) listener()
  }

  setArch(arch: Arch): void {
    if (arch === this.arch) return
    const previous = this.focused
    this.arch = arch
    this.focus = mapFocus(previous, this.design, this.stages[this.run.stage]!.role).id
    this.changed()
  }

  setExample(example: Example): void {
    if (example === this.example) return
    const previous = this.focused
    this.run.playing = false
    this.example = example
    this.focus = mapFocus(previous, this.design, this.stages[this.run.stage]!.role).id
    this.changed()
  }

  open(id: string): void {
    let module = this.design.modules.get(id)
    while (module && !module.children.length) module = module.parent ?? undefined
    if (!module || module.id === this.focus) return
    this.focus = module.id
    this.changed()
  }

  back(): void {
    const parent = this.focused.parent
    if (parent) this.open(parent.id)
  }

  setSpeed(speed: number): void {
    this.speed = speed
    this.changed()
  }

  play(): void {
    if (this.finished) {
      this.run.stage = 0
      this.run.progress = 0
    }
    this.run.playing = true
    this.changed()
  }

  pause(): void {
    this.run.playing = false
    this.changed()
  }

  step(): void {
    this.run.playing = false
    if (this.finished) this.run.stage = -1
    this.advance()
    this.run.progress = 1
    this.changed()
  }

  replay(play = true): void {
    const { run } = this
    run.stage = 0
    run.progress = 0
    run.playing = play
    if (this.example === 'counter') {
      run.inputs = { ...run.inputs, CLK: 0 }
      run.cycle = run.checkpoint.cycle
      run.history = [...run.checkpoint.history]
      // 主锁存在低电平时跟随当前输入；从锁存 Q 不变。
      run.regs = settle(this.design, run.inputs, run.checkpoint.regs)
    }
    this.changed()
  }

  /** 只推动一个时钟沿，中间状态走与连续播放相同的路径。 */
  clockEdge(): void {
    if (this.example !== 'counter') return
    const { run } = this
    run.playing = false
    const high = run.inputs.CLK === 1
    if (run.stage === FALL) this.advance()
    const target = high ? FALL : HIGH
    while (run.stage !== target) this.advance()
    run.progress = 1
    this.changed()
  }

  setInput(name: string, value: Bit): void {
    const { run, example } = this
    if (!(name in run.inputs) || name === 'CLK' || run.inputs[name] === value) return
    run.inputs = { ...run.inputs, [name]: value }
    if (example !== 'counter') {
      // 已走完的运算自动重演；中途暂停时只回到输入阶段。
      run.playing ||= this.finished
      run.stage = 0
      run.progress = 0
    } else {
      if (run.inputs.CLK === 0) {
        // 下降沿之后就是下一轮的低电平。
        if (run.stage === FALL) this.beginCycle()
        run.stage = 0
        run.progress = 0
      }
      // 从锁存在“采样”阶段尚未提交，此时不能提前更新 Q。
      if (run.stage !== RISE) run.regs = settle(this.design, run.inputs, run.regs)
      this.record()
    }
    this.changed()
  }

  tick(seconds: number): void {
    const { run } = this
    if (!run.playing) return
    run.progress += (seconds * this.speed) / STAGE_SECONDS
    if (run.progress < 1) return
    if (this.finished) {
      run.playing = false
      run.progress = 1
    } else {
      this.advance()
      run.progress = 0
    }
    this.changed()
  }

  private beginCycle(): void {
    const { run } = this
    run.cycle++
    run.checkpoint = { regs: { ...run.regs }, history: [...run.history], cycle: run.cycle }
  }

  private advance(): void {
    const { run, example } = this
    if (example === 'counter' && run.stage === FALL) {
      this.beginCycle()
      run.stage = 0
    } else {
      run.stage = Math.min(run.stage + 1, this.stages.length - 1)
      if (example === 'counter') {
        if (run.stage === RISE) run.inputs = { ...run.inputs, CLK: 1 }
        if (run.stage === FALL) run.inputs = { ...run.inputs, CLK: 0 }
        if (run.stage === UPDATE || run.stage === FALL) run.regs = settle(this.design, run.inputs, run.regs)
        if (run.stage >= READY) this.record()
      }
    }
    this.cached = null
  }

  private record(): void {
    this.cached = null
    const { run } = this
    run.history.push(sample(this.result, run.inputs, run.history.at(-1)))
    if (run.history.length > HISTORY_LIMIT) run.history.splice(0, run.history.length - HISTORY_LIMIT)
  }
}

function sample(result: Result, inputs: Inputs, previous?: Sample): Sample {
  // 加法逻辑还没传完时，D 引脚上仍是上一次稳定的值。
  const d = readWord(result, 'd') ?? previous?.d ?? null
  const q = result.design.probes.q!.reduce((sum, id, i) => sum + Number(display(result, id)) * 2 ** i, 0)
  return { stage: result.stage, clk: inputs.CLK!, en: inputs.EN!, clr: inputs.CLR!, d, q }
}

function createRun(example: Example): Run {
  const design = getDesign('amd', example)
  const inputs = DEFAULT_INPUTS[example]()
  const regs = settle(design, inputs, {})
  const history = example === 'counter'
    ? [sample({ design, stage: 0, values: propagate(design, inputs, regs) }, inputs)]
    : []
  return {
    inputs, regs, stage: 0, progress: 0, playing: false, cycle: 0, history,
    checkpoint: { regs: { ...regs }, history: [...history], cycle: 0 },
  }
}

/** 在目标设计中找同一功能、同一观察层级的模块。 */
export function mapFocus(previous: Module, design: Design, stageRole: string): Module {
  if (previous.kind === 'chip') return design.root
  if (previous.id.split('/')[1] === 'idle' && previous.kind === 'block') return design.idle

  const below: string[] = []
  let owner: Module | null = previous
  while (owner && !owner.role) {
    below.unshift(owner.key)
    owner = owner.parent
  }
  const container: Kind[] = ['block', 'slice', 'carry4']
  // 逻辑块的角色只代表它自己，不代表块内某一片 Slice 或选择器。
  if (owner?.role && (owner === previous || !container.includes(owner.kind))) {
    const target = design.roles.get(owner.role)
    if (target) {
      const same = design.modules.get([target.id, ...below].join('/'))
      return same?.children.length ? same : target
    }
  }
  if (previous.kind === 'switch') return design.modules.get(previous.id) ?? design.root

  const active = design.roles.get(stageRole)!
  return closest(active, previous.kind) ?? active
}
