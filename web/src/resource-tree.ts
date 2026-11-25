import { resourceTree, sampleBlock, type ResourceNode } from './logic/hierarchy.ts'
import type { Family } from './scene/types.ts'
import { icon, type IconName } from './ui.ts'

const kinds: Record<string, IconName> = {
  chip: 'chip',
  'logic-array': 'grid',
  block: 'grid',
  slice: 'slice',
  lut: 'layers',
  ff: 'pulse',
  carry: 'gate',
  gate: 'gate',
  mux: 'gate',
  'ram-group': 'layers',
  'dsp-group': 'chip',
  'clock-group': 'pulse',
  'io-group': 'slice',
  'routing-group': 'tree'
}
export class ResourceTree {
  private roots = { amd: resourceTree('amd'), ecp5: resourceTree('ecp5') }
  private expanded = {
    amd: new Set(['chip', 'chip/logic', 'chip/logic/' + sampleBlock('amd')]),
    ecp5: new Set(['chip', 'chip/logic', 'chip/logic/' + sampleBlock('ecp5')])
  }
  private rows = new Map<string, ResourceNode>()
  private family: Family = 'amd'
  private selected = ''
  constructor(
    private host: HTMLElement,
    private choose: (n: ResourceNode) => void
  ) {
    host.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-node]')
      if (!b) return
      const n = this.rows.get(b.dataset.node!)!
      if (b.dataset.toggle !== undefined || (!n.jump && !n.inspect)) {
        this.toggle(n)
        return
      }
      if (n.children) this.expanded[this.family].add(n.id)
      this.select(n.id, true)
      this.choose(n)
    })
    host.addEventListener('keydown', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[role=treeitem]')
      if (!row) return
      const all = [...host.querySelectorAll<HTMLElement>('[role=treeitem]')],
        i = all.indexOf(row),
        n = this.rows.get(row.dataset.node!)!
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        const at =
          e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1)
        all[Math.max(0, Math.min(at, all.length - 1))].focus()
        e.preventDefault()
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const set = this.expanded[this.family],
          open = set.has(n.id)
        if (n.children && open === (e.key === 'ArrowLeft')) this.toggle(n)
        else if (e.key === 'ArrowLeft') {
          const parent = n.id.slice(0, n.id.lastIndexOf('/'))
          host.querySelector<HTMLElement>('[role=treeitem][data-node="' + parent + '"]')?.focus()
        } else if (n.children) all[i + 1]?.focus()
        e.preventDefault()
      }
    })
    document.getElementById('fold-tree')!.onclick = () => {
      this.expanded[this.family] = new Set(['chip'])
      this.draw()
    }
  }
  get root() {
    return this.roots[this.family]
  }
  find(id: string) {
    let node: ResourceNode | undefined = this.root
    let path = 'chip'
    for (const part of id.split('/').slice(1)) {
      path += '/' + part
      node = node?.children?.().find((n) => n.id === path)
    }
    return node
  }
  pick(id: string) {
    const n = this.find(id)
    if (n) {
      this.select(id, true)
      this.choose(n)
    }
  }
  sync(family: Family, id: string) {
    if (family === this.family && id === this.selected) return
    this.family = family
    this.select(id)
  }
  private select(id: string, expandSelf = false) {
    const bits = id.split('/')
    for (let i = 1; i < bits.length; i++) this.expanded[this.family].add(bits.slice(0, i).join('/'))
    if (expandSelf && this.find(id)?.children) this.expanded[this.family].add(id)
    this.selected = id
    this.draw()
    const row = this.host.querySelector<HTMLElement>('[role=treeitem][data-node="' + id + '"]')
    if (row) {
      const area = this.host.getBoundingClientRect(),
        bounds = row.getBoundingClientRect()
      if (bounds.top < area.top) this.host.scrollTop += bounds.top - area.top
      else if (bounds.bottom > area.bottom) this.host.scrollTop += bounds.bottom - area.bottom
    }
  }
  private toggle(n: ResourceNode) {
    if (!n.children) return
    const s = this.expanded[this.family]
    if (s.has(n.id)) s.delete(n.id)
    else s.add(n.id)
    this.draw()
  }
  private draw() {
    const focused = (document.activeElement as HTMLElement)?.dataset.node
    this.rows.clear()
    const list: string[] = [],
      expanded = this.expanded[this.family]
    const visit = (n: ResourceNode, depth: number) => {
      this.rows.set(n.id, n)
      const open = expanded.has(n.id),
        current = this.selected === n.id
      const arrow = n.children
        ? '<button class="disclosure" data-toggle data-node="' +
          n.id +
          '" aria-label="' +
          (open ? '收起' : '展开') +
          n.label +
          '">' +
          icon(open ? 'down' : 'chevron', 12) +
          '</button>'
        : '<span class="disclosure"></span>'
      list.push(
        '<div class="resource-row' +
          (current ? ' current' : '') +
          '" style="--depth:' +
          depth +
          '">' +
          arrow +
          '<button role="treeitem" aria-level="' +
          (depth + 1) +
          '" aria-selected="' +
          current +
          '" ' +
          (n.children ? 'aria-expanded="' + open + '"' : '') +
          ' data-node="' +
          n.id +
          '" title="' +
          n.label +
          '">' +
          icon(kinds[n.kind] ?? (n.children ? 'layers' : 'cube'), 14) +
          '<span>' +
          n.label +
          '</span></button></div>'
      )
      if (open) n.children?.().forEach((c) => visit(c, depth + 1))
    }
    visit(this.root, 0)
    this.host.innerHTML = list.join('')
    if (focused)
      this.host
        .querySelector<HTMLElement>('[role=treeitem][data-node="' + focused + '"]')
        ?.focus({ preventScroll: true })
  }
}
