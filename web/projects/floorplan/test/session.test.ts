import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { closest } from '../src/model/cells.ts'
import { getDesign } from '../src/model/index.ts'
import { display, readWord } from '../src/model/sim.ts'
import { ARCHES, at, EXAMPLES, STAGES, type Arch, type Example } from '../src/model/stages.ts'
import { mapFocus, Session } from '../src/session.ts'

const other = (arch: Arch): Arch => (arch === 'amd' ? 'ecp5' : 'amd')

function start(arch: Arch, example: Example): Session {
  const session = new Session()
  session.setArch(arch)
  session.setExample(example)
  return session
}

const q = (session: Session) => readWord(session.result, 'q')

function until(session: Session, stage: string): void {
  const target = at(session.example, stage)
  for (let i = 0; session.run.stage !== target; i++) {
    assert.ok(i < 50, `到不了阶段 ${stage}`)
    session.step()
  }
}

test('默认从 AMD 7 系列的异或示例、芯片总览进入', () => {
  const session = new Session()
  assert.deepEqual([session.arch, session.example, session.focus, session.run.stage], ['amd', 'xor', 'chip', 0])
})

for (const arch of ARCHES) {
  describe(arch, () => {
    for (const example of EXAMPLES) {
      test(`${example}：每个阶段切换架构再切回，状态逐项相等`, () => {
        const session = start(arch, example)
        for (let i = 0; i < STAGES[example].length * 2; i++) {
          session.run.progress = 0.37
          const before = structuredClone(session.run)
          const output = session.design.probes.out!.map((id) => display(session.result, id))
          session.setArch(other(arch))
          assert.deepEqual(session.run, before)
          assert.deepEqual(session.design.probes.out!.map((id) => display(session.result, id)), output)
          session.setArch(arch)
          assert.deepEqual(session.run, before)
          session.step()
        }
      })
    }

    test('加法中途暂停后切换：输入、阶段不变，观察点落在对应 Slice', () => {
      for (let i = 0; i < 4; i++) {
        const session = start(arch, 'adder')
        session.setInput('B3', 1)
        until(session, `s${i}`)
        session.open(closest(session.active, 'slice')!.id)
        const run = structuredClone(session.run)
        session.setArch(other(arch))
        assert.deepEqual(session.run, run)
        assert.equal(session.focus, closest(session.design.roles.get(`carry:${i}`)!, 'slice')!.id)
      }
    })

    test('深层观察点切换后仍是同一功能', () => {
      const cases: [Example, string, string][] = [
        ['adder', 'lut:2', ''], ['adder', 'carry:3', ''], ['adder', 'carry:1', '/sum'], ['adder', 'carry:1', '/fa/p'],
        ['adder', 'exit', '/co'], ['counter', 'ff:3', ''], ['counter', 'ff:2', '/master'], ['xor', 'lut:0', '/m1_0'],
      ]
      for (const [example, role, below] of cases) {
        const session = start(arch, example)
        session.open(session.design.roles.get(role)!.id + below)
        session.setArch(other(arch))
        assert.equal(session.focus, session.design.roles.get(role)!.id + below, role + below)
      }
    })

    test('任一可展开模块切换后都落在可展开的模块上', () => {
      for (const example of EXAMPLES) {
        const target = getDesign(other(arch), example)
        for (const module of getDesign(arch, example).modules.values()) {
          if (!module.children.length) continue
          for (const stage of [STAGES[example][0]!, STAGES[example].at(-1)!]) {
            assert.ok(mapFocus(module, target, stage.role).children.length, module.id)
          }
        }
      }
    })

    test('手动时钟每次只推一个沿，下降沿保持', () => {
      const session = start(arch, 'counter')
      for (let edge = 1; edge <= 17; edge++) {
        session.clockEdge()
        assert.deepEqual([session.run.inputs.CLK, q(session)], [1, edge % 16])
        session.clockEdge()
        assert.deepEqual([session.run.inputs.CLK, q(session)], [0, edge % 16])
      }
    })

    test('手动与连续播放得到同一份波形和寄存器', () => {
      const manual = start(arch, 'counter')
      for (let i = 0; i < 34; i++) manual.clockEdge()
      const auto = start(arch, 'counter')
      auto.play()
      for (let i = 0; !(auto.run.cycle === 16 && auto.run.stage === at('counter', 'fall')); i++) {
        assert.ok(i < 1000)
        auto.tick(1.2)
      }
      assert.deepEqual(auto.run.history, manual.run.history)
      assert.deepEqual(auto.run.regs, manual.run.regs)
    })

    test('调速只改变速度，不改变阶段顺序', () => {
      const session = start(arch, 'adder')
      session.setSpeed(8)
      session.play()
      const seen = [0]
      for (let i = 0; session.run.playing && i < 2000; i++) {
        session.tick(0.02)
        if (seen.at(-1) !== session.run.stage) seen.push(session.run.stage)
      }
      assert.deepEqual(seen, STAGES.adder.map((_, i) => i))
    })

    test('暂停后时间不再推进', () => {
      const session = start(arch, 'adder')
      session.play()
      session.tick(1.2)
      session.pause()
      const run = structuredClone(session.run)
      session.tick(30)
      assert.deepEqual(session.run, run)
    })

    test('重播恢复本轮起点，不额外产生时钟沿', () => {
      for (const stage of ['p2', 'rise', 'update', 'high', 'fall']) {
        const session = start(arch, 'counter')
        session.clockEdge()
        session.clockEdge()
        session.step()
        const before = { q: q(session), history: structuredClone(session.run.history) }
        until(session, stage)
        session.replay(false)
        assert.deepEqual({ q: q(session), history: session.run.history }, before, stage)
        assert.deepEqual([session.run.stage, session.run.inputs.CLK], [0, 0])
      }
    })

    test('EN 关闭时保持；CLR 优先于 EN', () => {
      const session = start(arch, 'counter')
      for (let i = 0; i < 6; i++) session.clockEdge()
      assert.equal(q(session), 3)
      session.setInput('EN', 0)
      session.clockEdge()
      assert.equal(q(session), 3)
      session.clockEdge()
      session.setInput('CLR', 1)
      session.clockEdge()
      assert.equal(q(session), 0, 'EN=0 时同步清零仍生效')
    })

    test('采样之后改输入，不改本沿的结果', () => {
      const session = start(arch, 'counter')
      until(session, 'rise')
      assert.equal(readWord(session.result, 'captured'), 1)
      session.setInput('CLR', 1)
      assert.equal(readWord(session.result, 'captured'), 1)
      session.step()
      assert.equal(q(session), 1)
      session.clockEdge()
      assert.equal(q(session), 1, '下降沿不清零')
      session.clockEdge()
      assert.equal(q(session), 0)
    })

    test('低电平改输入会重算，下个沿按新值采样', () => {
      const session = start(arch, 'counter')
      until(session, 'ready')
      session.setInput('EN', 0)
      assert.equal(session.run.stage, 0)
      session.clockEdge()
      assert.equal(q(session), 0)
    })

    test('组合示例改输入回到输入阶段', () => {
      const session = start(arch, 'adder')
      until(session, 's2')
      session.setInput('A3', 1)
      assert.deepEqual([session.run.stage, session.run.playing], [0, false])
      until(session, 'output')
      session.setInput('A3', 0)
      assert.deepEqual([session.run.stage, session.run.playing], [0, true])
    })

    test('波形不含当前阶段以后的采样', () => {
      const session = start(arch, 'counter')
      for (let i = 0; i < 60; i++) {
        const { history, stage, cycle } = session.run
        const inCycle = [14, 15, 16, 17, 18].filter((s) => s <= stage).length
        assert.equal(history.length, 1 + cycle * 5 + inCycle)
        session.step()
      }
    })
  })
}
