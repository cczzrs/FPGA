export type Point = readonly [number, number]
export interface Rect { x: number; y: number; w: number; h: number }
export type Side = 'l' | 'r' | 't' | 'b'

/** 布线端点：exit 是离开端口一格后的网格点。 */
export interface Terminal {
  at: Point
  exit: Point
  side: Side
  /** 未选用的一端排在后面布线，主干只属于真正使用的连接。 */
  idle?: boolean
}

export interface Connection {
  net: number
  sources: Terminal[]
  sinks: Terminal[]
}

export interface Routed {
  paths: { net: number; points: Point[]; idle: boolean }[]
  junctions: { net: number; at: Point }[]
}

const STEP = 1
/** 拐弯比多走几格更贵：宁可绕远，也少折。 */
const TURN = 10
const CROSS = 3
/** 紧贴异线平行走：画面上像并成一根，尽量隔开一格。 */
const NEAR = 2
const FOREIGN = 80
const REUSE = 0.4

class Heap {
  private keys: number[] = []
  private ids: number[] = []

  get size(): number {
    return this.ids.length
  }

  push(key: number, id: number): void {
    const { keys, ids } = this
    let i = ids.length
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent]! <= key) break
      keys[i] = keys[parent]!
      ids[i] = ids[parent]!
      i = parent
    }
    keys[i] = key
    ids[i] = id
  }

  pop(): [number, number] {
    const { keys, ids } = this
    const top: [number, number] = [keys[0]!, ids[0]!]
    const key = keys.pop()!
    const id = ids.pop()!
    const n = ids.length
    if (n) {
      let i = 0
      for (;;) {
        let next = i * 2 + 1
        if (next >= n) break
        if (next + 1 < n && keys[next + 1]! < keys[next]!) next++
        if (key <= keys[next]!) break
        keys[i] = keys[next]!
        ids[i] = ids[next]!
        i = next
      }
      keys[i] = key
      ids[i] = id
    }
    return top
  }
}

/**
 * 网格正交布线：同线可分叉，异线只可垂直跨越，不可并线或在同一点拐弯。
 * 这样画面里的圆点只会出现在真正相连的地方。
 */
export function route(w: number, h: number, obstacles: Rect[], connections: Connection[]): Routed {
  const columns = w + 1
  const count = columns * (h + 1)
  const cell = ([x, y]: Point) => y * columns + x
  const point = (c: number): Point => [c % columns, Math.floor(c / columns)]
  const axisOf = (side: Side) => (side === 'l' || side === 'r' ? 0 : 1)

  const blocked = new Uint8Array(count)
  for (let x = 0; x <= w; x++) blocked[cell([x, 0])] = blocked[cell([x, h])] = 1
  for (let y = 0; y <= h; y++) blocked[cell([0, y])] = blocked[cell([w, y])] = 1
  for (const r of obstacles) {
    for (let y = r.y; y <= r.y + r.h; y++) for (let x = r.x; x <= r.x + r.w; x++) blocked[cell([x, y])] = 1
  }

  const used = [new Int32Array(count).fill(-1), new Int32Array(count).fill(-1)] as const
  const reserved = new Int32Array(count).fill(-1)
  for (const { net, sources, sinks } of connections) {
    for (const t of [...sources, ...sinks]) {
      const c = cell(t.exit)
      blocked[c] = 0
      reserved[c] = net
    }
  }

  const cost = new Float64Array(count * 2)
  const from = new Int32Array(count * 2)

  function search(net: number, starts: number[], target: number): number[] | null {
    cost.fill(Infinity)
    from.fill(-1)
    const heap = new Heap()
    const [tx, ty] = point(target)
    const estimate = (c: number) => Math.abs((c % columns) - tx) + Math.abs(Math.floor(c / columns) - ty)
    for (const state of starts) {
      cost[state] = 0
      heap.push(estimate(state >> 1), state)
    }
    while (heap.size) {
      const [priority, state] = heap.pop()
      const current = state >> 1
      const axis = state & 1
      const g = cost[state]!
      if (priority > g + estimate(current) + 1e-9) continue
      if (current === target) {
        const cells: number[] = []
        for (let s = state; s >= 0; s = from[s]!) cells.push(s >> 1)
        return cells.reverse()
      }
      const x = current % columns
      for (let direction = 0; direction < 4; direction++) {
        const nextAxis = direction >> 1
        if ((direction === 0 && x === w) || (direction === 1 && x === 0)) continue
        const next = current + (direction === 0 ? 1 : direction === 1 ? -1 : direction === 2 ? columns : -columns)
        if (next < 0 || next >= count || blocked[next]) continue
        const along = used[nextAxis]![next]!
        const across = used[1 - nextAxis]![next]!
        let step = along === net ? REUSE : STEP
        if (along >= 0 && along !== net) step += FOREIGN
        if (across >= 0 && across !== net) step += CROSS
        for (const side of nextAxis ? [-1, 1] : [-columns, columns]) {
          const beside = used[nextAxis]![next + side]
          if (beside !== undefined && beside >= 0 && beside !== net) step += NEAR
        }
        if (reserved[next]! >= 0 && reserved[next] !== net) step += FOREIGN
        if (nextAxis !== axis) {
          step += TURN
          const a = used[0][current]!
          const b = used[1][current]!
          if ((a >= 0 && a !== net) || (b >= 0 && b !== net)) step += FOREIGN
        }
        const nextState = next * 2 + nextAxis
        if (g + step < cost[nextState]!) {
          cost[nextState] = g + step
          from[nextState] = state
          heap.push(g + step + estimate(next), nextState)
        }
      }
    }
    return null
  }

  const paths: Routed['paths'] = []
  const junctions: Routed['junctions'] = []
  const distance = (a: Terminal, b: Terminal) => Math.abs(a.exit[0] - b.exit[0]) + Math.abs(a.exit[1] - b.exit[1])
  const reach = (c: Connection) => Math.max(...c.sinks.map((sink) => Math.min(...c.sources.map((s) => distance(s, sink)))))

  for (const { net, sources, sinks } of [...connections].sort((a, b) => reach(a) - reach(b))) {
    const tree = new Set<number>()
    const edges = new Map<string, [Point, Point]>()
    const connected = new Set<Terminal>()

    const connect = (starts: number[], target: Terminal, origins: Terminal[]) => {
      const cells = search(net, starts, cell(target.exit))
      if (!cells) throw new Error(`无法布线：net ${net}`)
      const origin = origins.find((s) => cell(s.exit) === cells[0])
      const points: Point[] = []
      if (origin && !connected.has(origin)) {
        connected.add(origin)
        points.push(origin.at)
      }
      points.push(...cells.map(point), target.at)
      for (let i = 1; i < cells.length; i++) {
        const axis = Math.abs(cells[i]! - cells[i - 1]!) === 1 ? 0 : 1
        used[axis][cells[i]!] = net
        used[axis][cells[i - 1]!] = net
      }
      for (const c of cells) tree.add(c)
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!
        const b = points[i]!
        edges.set([a.join(), b.join()].sort().join('|'), [a, b])
      }
      paths.push({ net, points: simplify(points), idle: !!target.idle })
    }

    const ordered = [...sinks].sort((a, b) => Number(!!a.idle) - Number(!!b.idle) || Math.min(...sources.map((s) => distance(s, a))) - Math.min(...sources.map((s) => distance(s, b))))
    for (const sink of ordered) {
      const starts = sources.map((s) => cell(s.exit) * 2 + axisOf(s.side))
      for (const c of tree) {
        const a = used[0][c]!
        const b = used[1][c]!
        if ((a < 0 || a === net) && (b < 0 || b === net)) starts.push(c * 2, c * 2 + 1)
      }
      connect(starts, sink, sources)
    }
    // 同一根线进入多个端口时，每个端口都要画出自己的引线。
    for (const source of sources) {
      if (connected.has(source)) continue
      const nearest = sinks.reduce((a, b) => (distance(source, a) <= distance(source, b) ? a : b))
      connect([cell(source.exit) * 2 + axisOf(source.side)], nearest, [source])
    }

    const degree = new Map<string, { n: number; at: Point }>()
    for (const pair of edges.values()) {
      for (const p of pair) {
        const entry = degree.get(p.join()) ?? { n: 0, at: p }
        entry.n++
        degree.set(p.join(), entry)
      }
    }
    for (const { n, at } of degree.values()) if (n > 2) junctions.push({ net, at })
  }
  return { paths, junctions }
}

function simplify(points: Point[]): Point[] {
  const result: Point[] = []
  for (const p of points) {
    const a = result.at(-2)
    const b = result.at(-1)
    if (b && b[0] === p[0] && b[1] === p[1]) continue
    if (a && b && ((a[0] === b[0] && b[0] === p[0] && (b[1] - a[1]) * (p[1] - b[1]) > 0)
      || (a[1] === b[1] && b[1] === p[1] && (b[0] - a[0]) * (p[0] - b[0]) > 0))) result.pop()
    result.push(p)
  }
  return result
}
