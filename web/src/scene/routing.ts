import { Vector3 } from 'three'
import type { SceneRoute } from './types.ts'

const epsilon = 1e-6
const clearance = 0.075
const ramp = 0.2
const lift = 0.18

interface Segment {
  a: Vector3
  b: Vector3
  direction: Vector3
  length: number
  start: number
  signal: string
}

interface Conflict {
  from: number
  to: number
  normal: Vector3
}

function segments(points: Vector3[], signal: string) {
  const result: Segment[] = []
  let start = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i]
    const direction = b.clone().sub(a)
    const length = direction.length()
    if (length <= epsilon) continue
    result.push({ a, b, direction: direction.divideScalar(length), length, start, signal })
    start += length
  }
  return result
}

// A shortcut may only cut the tiny corner inside an existing routing corridor.
// Long detours around a component retain their waypoints.
function simplify(points: Vector3[]) {
  if (points.length < 2) return points.slice()
  const result: Vector3[] = []
  function visit(start: number, end: number) {
    const a = points[start],
      span = points[end].clone().sub(a)
    const length2 = span.lengthSq()
    let worst = 0.055 ** 2,
      split = -1
    for (let i = start + 1; i < end; i++) {
      const delta = points[i].clone().sub(a)
      const t = length2 ? Math.max(0, Math.min(1, delta.dot(span) / length2)) : 0
      const d2 = delta.addScaledVector(span, -t).lengthSq()
      if (d2 > worst) {
        worst = d2
        split = i
      }
    }
    if (split >= 0) {
      visit(start, split)
      visit(split, end)
    } else if (!result.length || a.distanceToSquared(result[result.length - 1]) > epsilon ** 2) {
      result.push(a)
    }
  }
  visit(0, points.length - 1)
  const end = points[points.length - 1]
  if (result[result.length - 1].distanceToSquared(end) > epsilon ** 2) result.push(end)
  return result
}

// A bypass must also clear vertical vias. In a horizontal channel it rises
// primarily upwards with a small sideways offset visible from a top view.
function laneNormal(dir: Vector3) {
  const sideways = new Vector3(-dir.z, 0, dir.x)
  if (sideways.lengthSq() < epsilon) return new Vector3(1, 0, 0)
  sideways.normalize()
  if (sideways.z < 0 || (sideways.z === 0 && sideways.x < 0)) sideways.negate()
  return new Vector3(0, 1, 0)
    .addScaledVector(dir, -dir.y)
    .normalize()
    .addScaledVector(sideways, 0.47)
    .normalize()
}

function disjoint(a: Segment, b: Segment, margin: number) {
  for (const axis of ['x', 'y', 'z'] as const) {
    if (
      Math.max(a.a[axis], a.b[axis]) + margin < Math.min(b.a[axis], b.b[axis]) ||
      Math.max(b.a[axis], b.b[axis]) + margin < Math.min(a.a[axis], a.b[axis])
    )
      return true
  }
  return false
}

function contact(a: Segment, b: Segment, margin: number): Conflict | undefined {
  if (a.signal === b.signal || disjoint(a, b, margin)) return
  const delta = b.a.clone().sub(a.a)
  const normal = new Vector3().crossVectors(a.direction, b.direction)
  const cross2 = normal.lengthSq()
  if (cross2 < epsilon ** 2) {
    const t = delta.dot(a.direction)
    if (delta.addScaledVector(a.direction, -t).lengthSq() > margin ** 2) return
    const u = b.b.clone().sub(a.a).dot(a.direction)
    const low = Math.max(0, Math.min(t, u)),
      high = Math.min(a.length, Math.max(t, u))
    if (high - low > epsilon)
      return { from: a.start + low, to: a.start + high, normal: laneNormal(a.direction) }
    return
  }
  // Closest points on two directed lines. Bounds trim them to the actual segments.
  const t = delta.clone().cross(b.direction).dot(normal) / cross2
  const u = delta.clone().cross(a.direction).dot(normal) / cross2
  if (t < -epsilon || u < -epsilon || t > a.length + epsilon || u > b.length + epsilon) return
  normal.normalize()
  if (Math.abs(delta.dot(normal)) > margin) return
  if (
    normal.y < -epsilon ||
    (Math.abs(normal.y) <= epsilon && (normal.x < 0 || (normal.x === 0 && normal.z < 0)))
  )
    normal.negate()
  const distance = a.start + Math.max(0, Math.min(a.length, t))
  return { from: distance, to: distance, normal }
}

function allConflicts(
  path: Segment[],
  occupied: Segment[],
  pins: { at: Vector3; signal: string }[],
  margin: number
) {
  const conflicts: Conflict[] = []
  const last = path[path.length - 1]
  const length = last.start + last.length
  const interior = (s: number) => s > epsilon && s < length - epsilon
  for (const segment of path) {
    for (const wire of occupied) {
      const hit = contact(segment, wire, margin)
      // Different terminals sometimes share a component anchor in the teaching
      // model. Keep the anchor exact while separating their incoming segments.
      if (hit && (hit.to - hit.from > epsilon || interior(hit.from))) conflicts.push(hit)
    }
    // Reserve fixed ports even when their wire occurs later in the input.
    for (const pin of pins) {
      if (pin.signal === segment.signal) continue
      const delta = pin.at.clone().sub(segment.a)
      const t = delta.dot(segment.direction)
      const s = segment.start + t
      if (t < -epsilon || t > segment.length + epsilon || !interior(s)) continue
      if (delta.addScaledVector(segment.direction, -t).lengthSq() <= epsilon ** 2)
        conflicts.push({ from: s, to: s, normal: laneNormal(segment.direction) })
    }
  }
  return conflicts
}

function bypasses(hits: Conflict[], length: number) {
  const groups: Conflict[] = []
  for (const hit of hits.sort((a, b) => a.from - b.from)) {
    const prev = groups.at(-1)
    if (!prev || hit.from - prev.to >= ramp * 2) groups.push({ ...hit })
    else {
      if (hit.to - hit.from > prev.to - prev.from) prev.normal = hit.normal
      prev.to = Math.max(prev.to, hit.to)
    }
  }
  return groups.map(({ from, to, normal }) => {
    const left = Math.max(0, from - ramp),
      right = Math.min(length, to + ramp)
    const shoulder = Math.min(ramp, (right - left) / 3)
    const topL = from <= epsilon ? left + shoulder : from
    const topR = to >= length - epsilon ? right - shoulder : to
    return { left, topL, topR, right, normal }
  })
}

function bend(path: Segment[], spans: ReturnType<typeof bypasses>, attempt: number) {
  const last = path.at(-1)!
  const stops = [...path.map((s) => s.start), last.start + last.length]
  for (const s of spans) stops.push(s.left, s.topL, s.topR, s.right)
  stops.sort((a, b) => a - b)
  const points: Vector3[] = []
  let segmentIndex = 0,
    spanIndex = 0,
    previous = -Infinity
  for (const s of stops) {
    if (s - previous < epsilon) continue
    previous = s
    while (segmentIndex + 1 < path.length && path[segmentIndex + 1].start < s) segmentIndex++
    const p = path[segmentIndex]
    const point = p.a.clone().addScaledVector(p.direction, s - p.start)
    while (spanIndex < spans.length && spans[spanIndex].right < s) spanIndex++
    const span = spans[spanIndex]
    if (span && s > span.left && s < span.right) {
      const gain =
        s < span.topL
          ? (s - span.left) / (span.topL - span.left)
          : s > span.topR
            ? (span.right - s) / (span.right - span.topR)
            : 1
      // A second wire on an identical run needs a further local lane.
      point.addScaledVector(span.normal, lift * (1 + attempt) * gain)
      if (attempt) point.x += 0.037 * attempt * gain
    }
    points.push(point)
  }
  points[0] = path[0].a
  points[points.length - 1] = last.b
  return points
}

/** Keep terminals and signal identities intact while separating only local conflicts. */
export function routeWires(routes: SceneRoute[]): SceneRoute[] {
  const clean = routes.map((r) => ({ ...r, points: simplify(r.points) }))
  const pins = clean.flatMap((r) =>
    r.points.length
      ? [
          { at: r.points[0], signal: r.signal },
          { at: r.points.at(-1)!, signal: r.signal }
        ]
      : []
  )
  const occupied: Segment[] = []
  return clean.map((route) => {
    let path = segments(route.points, route.signal)
    if (!path.length) return route
    const hits = allConflicts(path, occupied, pins, clearance)
    if (hits.length) {
      const last = path.at(-1)!
      const spans = bypasses(hits, last.start + last.length)
      const base = path
      // Each previously occupied segment can exclude a candidate lane. A small
      // lateral skew also separates approaches to a shared terminal.
      for (let attempt = 0; attempt <= occupied.length + 1; attempt++) {
        route.points = bend(base, spans, attempt)
        path = segments(route.points, route.signal)
        if (!allConflicts(path, occupied, pins, epsilon).length) break
      }
    }
    occupied.push(...path)
    return route
  })
}
