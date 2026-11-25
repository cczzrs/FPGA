import type { Design, Module } from '../model/cells.ts'
import { at } from '../model/stages.ts'

const cache = new WeakMap<Module, Set<number>>()

/** 模块在哪些阶段承担工作：它产生当阶段出现的值，或它的锁存在当阶段保持、更新。 */
export function activeStages(design: Design, module: Module): Set<number> {
  let stages = cache.get(module)
  if (stages) return stages
  stages = new Set()
  for (const child of module.children) for (const s of activeStages(design, child)) stages.add(s)

  const outputs = module.ports.filter((p) => p.dir === 'out' && p.used)
  if (['and', 'or', 'not'].includes(module.kind)) for (const p of outputs) stages.add(design.nets[p.net]!.at)
  if (module.kind === 'pad') stages.add(module.at)
  if (module.kind === 'ff' && outputs.length && design.example === 'counter') {
    for (const id of ['rise', 'update', 'high', 'fall']) stages.add(at('counter', id))
  }
  if (module.kind === 'lut' && outputs.length && design.example === 'xor') {
    for (const id of ['pins', 'config']) stages.add(at('xor', id))
  }
  cache.set(module, stages)
  return stages
}

export function isUsed(module: Module): boolean {
  if (module.kind === 'pad') return true
  return module.ports.some((p) => p.dir === 'out' && p.used)
}
