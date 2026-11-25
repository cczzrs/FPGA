import test from 'node:test'
import assert from 'node:assert/strict'
import { startTiming, tick } from '../src/logic/clock.ts'
import { defaultInputs, simulate } from '../src/logic/simulator.ts'
import { netColor, signalValue, explainSignal } from '../src/logic/signals.ts'
for (const family of ['amd', 'ecp5']) {
  test(family + ' reference clock has observable edges without changing combinational outputs', () => {
    for (const demo of ['xor', 'adder']) {
      let t = startTiming()
      const input = defaultInputs(demo)
      for (let q = 0; q < 8; q++) {
        const s = simulate(family, demo, input, t.clock)
        assert.equal(demo === 'xor' ? s.values.Y : s.values.SUM, demo === 'xor' ? 1 : 8)
        t = tick(t, 0.25, input, s)
        assert.equal(t.clock.clk, [0, 1, 1, 0][q % 4])
        assert.equal(t.elapsed, q + 1)
      }
      assert.equal(t.edges, 4)
      assert.equal(t.rises, 2)
      assert.equal(t.clock.q, 0)
    }
  })
  test(family + ' sampled counter, quarter-cycle timing and mid-run frequency changes', () => {
    const input = defaultInputs('counter')
    let t = startTiming()
    const advance = (hz) => {
      t = tick(t, hz, input, simulate(family, 'counter', input, t.clock))
    }
    advance(0.25)
    assert.equal(t.clock.q, 0)
    advance(0.25)
    assert.equal(t.clock.q, 1)
    input.en = false
    advance(1)
    advance(1)
    advance(1)
    advance(1)
    assert.equal(t.clock.q, 1)
    assert.equal(t.elapsed, 3)
    assert.equal(t.rises, 2)
    input.reset = true
    for (let i = 0; i < 4; i++) advance(1)
    assert.equal(t.clock.q, 0)
  })
}
test('signal colors are independent of data, and cross-slice carry is described at its endpoints', () => {
  assert.equal(
    new Set(['A', 'B', 'Y', 'Q', 'D', 'CLK', 'C1', 'C2', 'C3', 'S1', 'P1'].map(netColor)).size,
    11
  )
  const s = simulate('ecp5', 'adder', defaultInputs('adder'), startTiming().clock)
  assert.equal(signalValue('SUM', s), '1000')
  assert.equal(signalValue('A[3:2]', s), '01')
  const d = explainSignal('C2', s, { level: 'block' })
  assert.match(d.purpose, /Slice 0.*Slice 1/)
  assert.match(d.from, /位 1/)
  assert.match(d.to, /位 2/)
})
