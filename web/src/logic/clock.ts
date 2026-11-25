import { initialClock, toggleClock, type Inputs, type Snapshot } from './simulator.ts'

export const startTiming = () => ({
  phase: 0,
  edges: 0,
  rises: 0,
  elapsed: 0,
  clock: initialClock(),
  last: '初始低电平'
})
export type Timing = ReturnType<typeof startTiming>
/** Logical macro-steps consume a quarter-cycle. Examining a gate consumes no clock time. */
export function tick(t: Timing, hz: number, input: Inputs, snapshot: Snapshot): Timing {
  const phase = (t.phase + 1) % 4,
    level = phase >= 2 ? 1 : 0
  const next = { ...t, phase, elapsed: t.elapsed + 1 / (hz * 4) }
  if (t.clock.clk === level) return next
  return {
    ...next,
    clock: snapshot.demo === 'counter' ? toggleClock(t.clock, input, snapshot) : { ...t.clock, clk: level },
    edges: t.edges + 1,
    rises: t.rises + level,
    last: level ? '上升沿' : '下降沿'
  }
}
