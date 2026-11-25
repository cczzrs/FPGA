import type { Design, Module } from '../model/cells.ts'
import type { Pin, Scene } from './layout.ts'

/** 一条路径：总览里是“引脚 → 开关盒 → 连接盒 → 逻辑块”整条，其余层级是一根线。 */
export interface Path {
  key: string
  nets: number[]
  name: string
  from: string[]
  to: string[]
  /** 线上的值取这根线（路径末段，最接近负载的一段）。 */
  net: number
  color: string
  used: boolean
  constant: boolean
}

export interface Paths {
  list: Path[]
  byNet: Map<number, Path>
}

const short = (module: Module) => module.name.split(' · ')[0]!
const CONSTANT_COLOR = '#8793a3'
const UNUSED_COLOR = '#4a586c'

/** 黄金角取色：相邻序号的色相相差约 137.5°，路径再多也彼此分得开。 */
export function pathColor(index: number): string {
  const hue = (index * 137.508 + 188) % 360
  return `hsl(${hue.toFixed(1)} 78% 62%)`
}

function pinText(pin: Pin): string {
  if (pin.boundary) return `边界 ${pin.name}`
  return pin.module.kind === 'pad' ? `引脚 ${pin.module.name}` : `${short(pin.module)}.${pin.name}`
}

const cache = new WeakMap<Scene, Paths>()

export function paths(design: Design, scene: Scene): Paths {
  const known = cache.get(scene)
  if (known) return known
  const { focus } = scene
  const list: Path[] = []
  const byNet = new Map<number, Path>()
  const add = (path: Omit<Path, 'color'>) => {
    const entry = { ...path, color: '' }
    list.push(entry)
    for (const net of path.nets) byNet.set(net, entry)
  }
  const wired = new Set(scene.wires.filter((w) => !(focus.kind === 'lut' && w.from)).map((w) => w.net))

  // 经互连的输入、输出、反馈各成一条路径。
  for (const r of design.routes) {
    const middle = r.sb.ports.find((p) => p.dir === 'out')!.net
    const nets = [...new Set(focus.kind === 'chip' ? [r.src, middle, r.dst] : [r.src, r.dst])].filter((n) => wired.has(n) && !byNet.has(n))
    if (!nets.length || (focus.kind !== 'chip' && r.type !== 'feedback')) continue
    const name = r.type === 'feedback' ? `反馈 ${r.sb.key.replace('sb_back_', '')}` : `${r.type === 'in' ? '输入' : '输出'} ${r.pad!.name}`
    const hops = ['开关盒', ...(r.cb ? ['连接盒'] : [])]
    const block = focus.kind === 'chip' ? short(design.roles.get('block')!) : '本模块'
    const from = r.type === 'in' ? [`引脚 ${r.pad!.name}`] : [`${block} 输出`]
    const to = r.type === 'out' ? [...hops, `引脚 ${r.pad!.name}`] : [...hops, `${block} 输入`]
    add({ key: `route:${r.sb.key}`, nets, name, from, to, net: r.type === 'feedback' && focus.kind !== 'chip' ? r.dst : nets.at(-1)!, used: true, constant: false })
  }

  // 其余每根线自成一条，名字取它的驱动端口。
  for (const net of wired) {
    if (byNet.has(net)) continue
    const pins = scene.pins.filter((p) => p.net === net)
    const drives = (p: Pin) => (p.boundary ? p.dir === 'in' : p.dir === 'out')
    const sources = pins.filter(drives)
    const sinks = pins.filter((p) => !drives(p))
    const wires = scene.wires.filter((w) => w.net === net)
    const info = design.nets[net]!
    const constant = info.constant !== undefined
    const named = sources.find((p) => p.boundary) ?? sinks.find((p) => p.boundary) ?? sources[0] ?? sinks[0]
    const name = constant ? `${info.name}` : named ? (named.boundary ? named.name : `${short(named.module)}.${named.name}`) : info.name
    add({
      key: `net:${net}`, nets: [net], name, net,
      from: sources.map(pinText), to: sinks.filter((p) => p.used).map(pinText),
      used: wires.some((w) => !w.idle), constant,
    })
  }

  // 使用中的路径在前；同类按名字排，颜色按此顺序分配，重进同一层颜色不变。
  list.sort((a, b) => Number(b.used && !b.constant) - Number(a.used && !a.constant) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  let index = 0
  for (const path of list) path.color = path.constant ? CONSTANT_COLOR : path.used ? pathColor(index++) : UNUSED_COLOR
  const result = { list, byNet }
  cache.set(scene, result)
  return result
}
