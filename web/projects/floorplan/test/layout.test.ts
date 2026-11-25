import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Design, Module } from '../src/model/cells.ts'
import { getDesign } from '../src/model/index.ts'
import { display, displayPort, propagate, revealed } from '../src/model/sim.ts'
import { ARCHES, EXAMPLES, STAGES } from '../src/model/stages.ts'
import { layout, type Scene } from '../src/scene/layout.ts'
import type { Point } from '../src/scene/route.ts'
import { Session } from '../src/session.ts'

/** 所有可进入的观察层级。LUT 内结构相同的 MUX 每个 LUT 只取一个。 */
function views(design: Design): Module[] {
  return [...design.modules.values()].filter(
    (m) => m.children.length && !(m.kind === 'mux' && m.parent?.kind === 'lut' && m.key !== 'm0_0'))
}

const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1]

function units(a: Point, b: Point): [Point, Point][] {
  const steps = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])
  const dx = Math.sign(b[0] - a[0])
  const dy = Math.sign(b[1] - a[1])
  return Array.from({ length: steps }, (_, i) => [[a[0] + dx * i, a[1] + dy * i], [a[0] + dx * (i + 1), a[1] + dy * (i + 1)]])
}

const isSchematic = (scene: Scene) => scene.focus.kind !== 'chip' && scene.focus.kind !== 'lut'

for (const arch of ARCHES) {
  for (const example of EXAMPLES) {
    describe(`${arch}/${example}`, () => {
      const design = getDesign(arch, example)
      const all = views(design)

      test('每个子模块都有位置，端口互不重合', () => {
        for (const focus of all) {
          const scene = layout(design, focus)
          if (focus.kind !== 'chip') {
            const placed = new Set(scene.boxes.filter((b) => !b.preview).map((b) => b.module))
            for (const child of focus.children) assert.ok(placed.has(child), child.id)
          }
          const points = new Set<string>()
          for (const pin of scene.pins) {
            const key = `${pin.at}/${pin.boundary}`
            assert.ok(!points.has(key), `${focus.id} 端口重叠 ${pin.name}`)
            points.add(key)
          }
        }
      })

      test('连线正交、异线不并线、不穿过模块', () => {
        for (const focus of all) {
          const scene = layout(design, focus)
          if (!isSchematic(scene)) continue
          const owner = new Map<string, number>()
          const solid = scene.boxes.filter((b) => !b.preview && !b.group).map((b) => b.rect)
          for (const wire of scene.wires) {
            if (wire.feedback) continue
            for (let i = 1; i < wire.points.length; i++) {
              const a = wire.points[i - 1]!
              const b = wire.points[i]!
              assert.ok(a[0] === b[0] || a[1] === b[1], `${focus.id} 斜线`)
              for (const [p, r] of units(a, b)) {
                const key = [p.join(), r.join()].sort().join('|')
                assert.ok((owner.get(key) ?? wire.net) === wire.net, `${focus.id} 并线于 ${key}`)
                owner.set(key, wire.net)
                const x = (p[0] + r[0]) / 2
                const y = (p[1] + r[1]) / 2
                for (const box of solid) {
                  assert.ok(!(x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h), `${focus.id} 穿过模块`)
                }
              }
            }
          }
        }
      })

      test('每个已用端口连到同一根线的唯一驱动', () => {
        for (const focus of all) {
          const scene = layout(design, focus)
          if (!isSchematic(scene)) continue
          const nets = new Map<number, typeof scene.pins>()
          for (const pin of scene.pins) nets.set(pin.net, [...(nets.get(pin.net) ?? []), pin])
          for (const [net, pins] of nets) {
            const sources = pins.filter((p) => (p.boundary ? p.dir === 'in' : p.dir === 'out'))
            const inner = sources.filter((p) => !p.boundary)
            assert.ok(inner.length <= 1 && !(inner.length && sources.length > 1), `${focus.id} 多个驱动`)
            const sinks = pins.filter((p) => !sources.includes(p) && p.used)
            if (!sources.length || !sinks.length) continue
            const links = new Map<string, string[]>()
            for (const wire of scene.wires) {
              if (wire.net !== net || wire.feedback) continue
              for (let i = 1; i < wire.points.length; i++) {
                for (const [p, r] of units(wire.points[i - 1]!, wire.points[i]!)) {
                  links.set(p.join(), [...(links.get(p.join()) ?? []), r.join()])
                  links.set(r.join(), [...(links.get(r.join()) ?? []), p.join()])
                }
              }
            }
            const reached = new Set(sources.map((p) => p.at.join()))
            for (const key of reached) for (const next of links.get(key) ?? []) reached.add(next)
            for (const sink of sinks) {
              assert.ok(reached.has(sink.at.join()), `${focus.id} ${sink.name} 未连通`)
              const ending = scene.wires.filter((w) => w.net === net && same(w.points.at(-1)!, sink.at))
              assert.ok(ending.some((w) => !w.idle), `${focus.id} ${sink.name} 被画成未使用`)
            }
          }
        }
      })

      test('跨越模块边界的线都有端口', () => {
        const driver = new Map<number, string>()
        // 锁存的 Q、QN 由反馈门驱动，这些门不在组合顺序里。
        for (const m of design.modules.values()) {
          if (m.kind === 'and' || m.kind === 'or' || m.kind === 'not') driver.set(m.ports.at(-1)!.net, m.id)
        }
        for (const gate of design.order) {
          for (const id of gate.inputs) {
            for (let m = gate.module.parent; m?.parent; m = m.parent) {
              // 全加器等效图是只读观察，不是硬件连线。
              if (m.kind === 'adder') break
              const from = driver.get(id)
              if (from?.startsWith(`${m.id}/`)) break
              if (!from && design.nets[id]!.constant !== undefined) break
              assert.ok(m.ports.some((p) => p.net === id), `${m.id} 缺端口：${design.nets[id]!.name}`)
            }
          }
        }
      })

      test('每层在每个阶段的显示值都等于求值结果', () => {
        const session = new Session()
        session.setArch(arch)
        session.setExample(example)
        for (let i = 0; i < STAGES[example].length; i++) {
          const { result } = session
          const truth = propagate(design, session.run.inputs, session.run.regs)
          for (const focus of all) {
            const scene = layout(design, focus)
            for (const pin of scene.pins) {
              const shown = displayPort(result, pin)
              const net = design.nets[pin.net]!
              const wanted = !pin.used || !net.used ? 'unused' : revealed(example, net.at, result.stage) ? truth[pin.net] : 'pending'
              assert.equal(shown, wanted, `${focus.id} ${pin.name}`)
            }
            for (const wire of scene.wires) {
              const shown = display(result, wire.net)
              if (typeof shown === 'number') assert.equal(shown, truth[wire.net])
            }
          }
          session.step()
        }
      })
    })
  }
}
