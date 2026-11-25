import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bit,
  simulate,
  initialClock,
  toggleClock,
  defaultInputs,
  families
} from '../src/logic/simulator.ts'
import { gateGraph } from '../src/logic/gates.ts'
import { buildBlock, buildSlice } from '../src/scene/fabric.ts'
import { buildChip } from '../src/scene/chip.ts'

const loc = (unit, lane, lanes) => ({ level: 'gate', unit, bit: lane, slice: Math.floor(lane / lanes) })
for (const family of ['amd', 'ecp5']) {
  const spec = families[family]
  test(family + ' XOR addresses, stored bits and every mux layer', () => {
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++) {
        const s = simulate(family, 'xor', { ...defaultInputs('xor'), a, b }, initialClock())
        const lut = s.luts[0]
        assert.equal(lut.rows[0].length, 1 << spec.width)
        assert.equal(lut.address, a + 2 * b)
        assert.equal(s.values.Y, a ^ b)
        for (let tier = 1; tier <= spec.width; tier++)
          for (let index = 0; index < lut.rows[tier].length; index++) {
            const g = gateGraph(s, { ...loc('lut', 0, spec.lanes), tier, muxIndex: index })
            assert.equal(g.values.out, lut.rows[tier][index])
          }
        assert.equal(gateGraph(s, loc('lut', 1, spec.lanes)).values.out, undefined)
      }
  })
  test(family + ' all 256 additions and gate-level sum/carry at each bit', () => {
    for (let a = 0; a < 16; a++)
      for (let b = 0; b < 16; b++) {
        const s = simulate(family, 'adder', { ...defaultInputs('adder'), a, b }, initialClock())
        assert.equal(s.values.SUM, (a + b) % 16)
        assert.equal(s.values.C4, Number(a + b >= 16))
        for (let n = 0; n < 4; n++) {
          const g = gateGraph(s, loc('carry', n, spec.lanes))
          const mask = (1 << (n + 1)) - 1
          assert.equal(s.values['C' + (n + 1)], Number((a & mask) + (b & mask) > mask))
          assert.equal(g.values.cout, s.values['C' + (n + 1)])
          assert.equal(g.values.sum, bit(a + b, n))
        }
      }
  })
  test(family + ' rising-edge sampling, feedback gates, hold, wrap and reset priority', () => {
    let c = initialClock()
    const i = defaultInputs('counter')
    const snap = () => simulate(family, 'counter', i, c)
    const checkGates = () => {
      const s = snap()
      for (let n = 0; n < 4; n++) {
        const g = gateGraph(s, loc('ff', n, spec.lanes))
        assert.equal(g.values.out, bit(c.q, n))
        assert.equal(g.values.gm, s.values['M' + n])
        for (const node of g.probes)
          if (node.op === 'NAND') {
            const [a, b] = node.inputs.map((id) => g.values[id])
            assert.equal(g.values[node.id], Number(!(a && b)))
          }
      }
    }
    for (let n = 0; n < 16; n++) {
      assert.equal(snap().values.D, (n + 1) & 15)
      checkGates()
      c = toggleClock(c, i, snap())
      assert.equal(c.q, (n + 1) & 15)
      checkGates()
      i.reset = true
      checkGates()
      assert.equal(c.q, (n + 1) & 15)
      c = toggleClock(c, i, snap())
      assert.equal(c.q, (n + 1) & 15)
      checkGates()
      i.reset = false
    }
    c = toggleClock(c, i, snap())
    c = toggleClock(c, i, snap())
    assert.equal(c.q, 1)
    i.en = false
    c = toggleClock(c, i, snap())
    assert.equal(c.q, 1)
    checkGates()
    c = toggleClock(c, i, snap())
    i.reset = true
    c = toggleClock(c, i, snap())
    assert.equal(c.q, 0)
    checkGates()
  })
  test(family + ' hierarchy and all macro / Slice traces resolve to assigned nets', () => {
    for (const demo of ['xor', 'adder', 'counter']) {
      const s = simulate(family, demo, defaultInputs(demo), initialClock())
      const base = { ...loc('lut', 0, spec.lanes), level: 'block' }
      const block = buildBlock(family, demo, base)
      const sliceTargets = new Set(
        block.labels.flatMap((l) => (l.jump?.level === 'slice' ? [l.jump.slice] : []))
      )
      assert.equal(sliceTargets.size, spec.slices)
      assert.equal(
        block.labels.some((l) => l.text === '跨 Slice 进位' && l.signal === 'C2'),
        family === 'ecp5' && demo !== 'xor'
      )
      const assets = [buildChip(family, demo), block]
      for (let slice = 0; slice < spec.slices; slice++) {
        const a = buildSlice(family, demo, { ...base, slice, bit: slice * spec.lanes, level: 'slice' })
        if (slice * spec.lanes >= s.usedBits) assert.equal(a.routes.length, 0)
        assets.push(a)
      }
      for (const asset of assets)
        for (const route of asset.routes) {
          assert.ok(Object.hasOwn(s.values, route.signal), route.signal)
          assert.ok(
            route.points.length >= 2 && route.points.every((p) => p.toArray().every(Number.isFinite))
          )
        }
    }
  })
}
