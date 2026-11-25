import test from 'node:test'
import assert from 'node:assert/strict'
import { Vector3 } from 'three'
import { routeWires } from '../src/scene/routing.ts'
import { buildChip } from '../src/scene/chip.ts'
import { buildBlock, buildSlice } from '../src/scene/fabric.ts'
import { buildGates, buildUnit } from '../src/scene/detail.ts'
import { gateGraph } from '../src/logic/gates.ts'
import { simulate, defaultInputs, initialClock } from '../src/logic/simulator.ts'

const v = (x, y, z) => new Vector3(x, y, z)
const wire = (signal, ...points) => ({ signal, points: points.map((p) => v(...p)) })
const snapshot = (r) => r.map((w) => w.points.map((p) => p.toArray()))

function verify(routes) {
  const before = snapshot(routes)
  const routed = routeWires(routes)
  assert.deepEqual(snapshot(routes), before)
  assert.equal(routed.length, routes.length)
  const segments = []
  for (const [i, { signal, points }] of routed.entries()) {
    assert.equal(signal, routes[i].signal)
    assert.deepEqual(points[0]?.toArray(), before[i][0])
    assert.deepEqual(points.at(-1)?.toArray(), before[i].at(-1))
    for (let j = 1; j < points.length; j++) {
      const a = points[j - 1],
        b = points[j],
        length = a.distanceTo(b)
      assert.ok(length > 1e-7)
      const axis = b.clone().sub(a).divideScalar(length)
      for (const other of segments) {
        if (signal === other.signal) continue
        const da = other.a.clone().sub(a),
          db = other.b.clone().sub(a)
        // Both endpoints on this line and intervals with positive common length
        // would give two independently colored nets the same rendered segment.
        if (da.clone().cross(axis).length() > 1e-7 || db.clone().cross(axis).length() > 1e-7) continue
        const ta = da.dot(axis),
          tb = db.dot(axis)
        const overlap = Math.min(length, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb))
        assert.ok(overlap < 1e-7, signal + ' overlaps ' + other.signal + ' by ' + overlap)
      }
      segments.push({ a, b, signal })
    }
  }
  return routed
}

test('removes duplicates, straight-through vertices, and small gratuitous doglegs', () => {
  const [r] = verify([wire('A', [0, 0, 0], [0, 0, 0], [0.5, 0, 0], [1, 0, 0.025], [2, 0, 0])])
  assert.equal(r.points.length, 2)
  const [detour] = verify([wire('B', [0, 0, 0], [0, 0, 1], [2, 0, 1], [2, 0, 0])])
  assert.equal(detour.points.length, 4)
})

test('same net can share its trunk; several distinct nets can use identical fixed terminals', () => {
  const same = [wire('A', [0, 0, 0], [1, 0, 0]), wire('A', [0, 0, 0], [1, 0, 0], [1, 0, 1])]
  assert.deepEqual(snapshot(verify(same)), snapshot(same))
  verify([
    ...Array.from({ length: 6 }, (_, i) => wire('D' + i, [0, 0, 0], [4, 0, 0])),
    wire('reverse', [3, 0, 0], [1, 0, 0])
  ])
})

test('independent crossing gets a short bridge; existing separated layers remain direct', () => {
  const base = wire('H', [-2, 0, 0], [2, 0, 0])
  const crossing = wire('V', [0, 0, -2], [0, 0, 2])
  const [first, raised] = verify([base, crossing])
  assert.equal(first.points.length, 2)
  assert.ok(raised.points.some((p) => Math.abs(p.z) < 1e-6 && p.y > 0.1))
  assert.ok(raised.points.slice(1, -1).every((p) => Math.abs(p.z) < 0.25))
  const high = wire('high', [0, 0.7, -2], [0, 0.7, 2])
  assert.deepEqual(snapshot(verify([base, high])), snapshot([base, high]))
})

test('protects foreign ports inside a run and separates shared vertical or oblique runs', () => {
  const [through] = verify([wire('through', [-1, 0, 0], [1, 0, 0]), wire('pin', [0, 0, 0], [0, 0, 1])])
  assert.ok(through.points.some((p) => p.y > 0.1))
  verify([
    wire('V1', [0, 0, 0], [0, 3, 0]),
    wire('V2', [0, 1, 0], [0, 2.5, 0]),
    wire('slant', [-1, 0, 0], [2, 3, 3]),
    wire('reversed', [1, 2, 2], [0, 1, 1])
  ])
})

for (const family of ['amd', 'ecp5']) {
  test(family + ' LUT trees, dedicated units and equivalent gates have no overlapping foreign nets', () => {
    for (const [demo, unit] of [
      ['xor', 'lut'],
      ['adder', 'carry'],
      ['counter', 'ff'],
      ['xor', 'mux']
    ]) {
      const s = simulate(family, demo, defaultInputs(demo), initialClock())
      const loc = { level: 'unit', unit, bit: 0, slice: 0 }
      verify(buildUnit(s, loc).routes)
      verify(buildGates(gateGraph(s, loc)).routes)
    }
  })
  test(family + ' chip, block and slice keep every terminal with no overlapping foreign nets', () => {
    for (const demo of ['xor', 'adder', 'counter']) {
      const loc = { level: 'block', unit: 'lut', slice: 0, bit: 0 }
      const assets = [buildChip(family, demo), buildBlock(family, demo, loc)]
      for (let slice = 0; slice < (family === 'amd' ? 2 : 4); slice++)
        assets.push(
          buildSlice(family, demo, {
            ...loc,
            level: 'slice',
            slice,
            bit: family === 'amd' ? slice * 4 : slice * 2
          })
        )
      for (const a of assets) verify(a.routes)
    }
  })
}
