import { buildAmd } from './amd.ts'
import { buildEcp5 } from './ecp5.ts'
import type { Design } from './cells.ts'
import type { Arch, Example } from './stages.ts'

const cache = new Map<string, Design>()

export function getDesign(arch: Arch, example: Example): Design {
  const key = `${arch}/${example}`
  let design = cache.get(key)
  if (!design) cache.set(key, (design = (arch === 'amd' ? buildAmd : buildEcp5)(example)))
  return design
}
