import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildAmd } from '../src/model/amd.ts'
import { child, closest, port, type Bit, type Design } from '../src/model/cells.ts'
import { buildEcp5 } from '../src/model/ecp5.ts'
import { getDesign } from '../src/model/index.ts'
import { display, propagate, selection, settle, type Registers } from '../src/model/sim.ts'
import { ARCHES, at, EXAMPLES, STAGES, type Arch } from '../src/model/stages.ts'
import { adderInputs, bench, bit, evaluateModule, word } from './helpers.ts'

describe('单元', () => {
  for (const { size, init, tap } of [
    { size: 6, init: 0x8f3a51c6e209b7d4n, tap: 5 },
    { size: 4, init: 0xb2c5n, tap: 2 },
  ]) {
    test(`LUT${size}：非对称 INIT 的全部 ${2 ** size} 个地址与引出子树`, () => {
      const design = bench((b) => {
        const pins = Array.from({ length: size }, (_, i): [string, number] => [`P${i}`, b.net(`P${i}`, { input: `P${i}` })])
        const lut = b.lut(b.root, 'lut', 'LUT', pins, init, { main: 'O', tap: 'T', level: tap })
        return { out: [lut.out], tap: [lut.tap] }
      })
      for (let address = 0; address < 2 ** size; address++) {
        const inputs = Object.fromEntries(Array.from({ length: size }, (_, i) => [`P${i}`, bit(address, i)]))
        const values = propagate(design, inputs, {})
        assert.equal(values[design.probes.out![0]!], Number((init >> BigInt(address)) & 1n))
        assert.equal(values[design.probes.tap![0]!], Number((init >> BigInt(address % 2 ** tap)) & 1n))
      }
    })
  }

  test('2:1 选择器与异或门的全真值表', () => {
    const design = bench((b) => {
      const [a, c, s] = ['A', 'B', 'S'].map((name) => b.net(name, { input: name })) as [number, number, number]
      return { mux: [b.mux(b.root, 'mux', 'MUX', a, c, s)], xor: [b.xor(b.root, 'xor', 'XOR', a, c)] }
    })
    for (let i = 0; i < 8; i++) {
      const [A, B, S] = [bit(i, 0), bit(i, 1), bit(i, 2)]
      const values = propagate(design, { A, B, S }, {})
      assert.equal(values[design.probes.mux![0]!], S ? B : A)
      assert.equal(values[design.probes.xor![0]!], A === B ? 0 : 1)
    }
  })

  test('CARRY4：1024 组端口值符合 UNISIM 公式', () => {
    const design = getDesign('amd', 'adder')
    const carry4 = design.modules.get('chip/block/s0/carry4')!
    for (let v = 0; v < 1024; v++) {
      const inputs: Record<string, Bit> = { CI: bit(v, 8), CYINIT: bit(v, 9) }
      for (let i = 0; i < 4; i++) {
        inputs[`S${i}`] = bit(v, i)
        inputs[`DI${i}`] = bit(v, 4 + i)
      }
      const out = evaluateModule(design, carry4, inputs)
      let carry: number = inputs.CI! | inputs.CYINIT!
      for (let i = 0; i < 4; i++) {
        assert.equal(out[`O${i}`], inputs[`S${i}`]! ^ carry)
        carry = inputs[`S${i}`] ? carry : inputs[`DI${i}`]!
        assert.equal(out[`CO${i}`], carry)
      }
    }
  })

  test('CCU2C：INJECT1 两种配置的全真值表', () => {
    const design = getDesign('ecp5', 'adder')
    for (const [id, enabled] of [['chip/block/s1/ccu0', 1], ['chip/block/s0/ccu1', 0]] as const) {
      for (let v = 0; v < 8; v++) {
        const [L, G, CI] = [bit(v, 0), bit(v, 1), bit(v, 2)]
        const out = evaluateModule(design, design.modules.get(id)!, { L, G, CI })
        assert.equal(out.S, L ^ (enabled ? CI : 0))
        assert.equal(out.CO, ((1 - L) & (enabled ? G : 0)) | (L & CI))
      }
    }
  })

  test('D 触发器：旧值 × D × CE × R，只在上升沿采样', () => {
    const design = bench((b) => {
      const [d, ce, r, clk] = ['D', 'CE', 'R', 'CLK'].map((name) => b.net(name, { input: name })) as [number, number, number, number]
      return { q: [b.flipFlop(b.root, 'ff', 'FF', { d, ce, r, clk }, { bit: 0 })] }
    })
    for (let v = 0; v < 16; v++) {
      const [Q, D, CE, R] = [bit(v, 0), bit(v, 1), bit(v, 2), bit(v, 3)]
      const low = settle(design, { D, CE, R, CLK: 0 }, { s0: Q })
      assert.equal(low.s0, Q, '低电平时 Q 必须保持')
      const high = settle(design, { D, CE, R, CLK: 1 }, low)
      const expected = R ? 0 : CE ? D : Q
      assert.equal(high.s0, expected)
      for (const [d, ce, r] of [[0, 1, 0], [1, 1, 0], [1, 0, 1]] as const) {
        assert.equal(settle(design, { D: d, CE: ce, R: r, CLK: 1 }, high).s0, expected, '高电平时不得穿通')
      }
      assert.equal(settle(design, { D, CE, R, CLK: 0 }, high).s0, expected, '下降沿必须保持')
    }
  })
})

/** 与网表无关的整数参照。返回不一致的描述。 */
function adderErrors(design: Design): string[] {
  const errors: string[] = []
  const { probes } = design
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      const values = propagate(design, adderInputs(a, b), {})
      const expect = (what: string, net: number, wanted: number) => {
        if (values[net] !== wanted) errors.push(`${a}+${b} ${what}`)
      }
      for (let i = 0; i < 4; i++) {
        const mask = 2 ** i - 1
        const cin = ((a & mask) + (b & mask)) >> i
        const sum = bit(a, i) + bit(b, i) + cin
        expect(`P${i}`, probes.p![i]!, bit(a, i) ^ bit(b, i))
        expect(`Cin${i}`, probes.cin![i]!, cin)
        expect(`S${i}`, probes.sum![i]!, sum & 1)
        expect(`Cout${i}`, probes.cout![i]!, sum >> 1)
        expect(`全加器 S${i}`, probes.faSum![i]!, sum & 1)
        expect(`全加器 Cout${i}`, probes.faCout![i]!, sum >> 1)
      }
      expect('进位引出', probes.exit![0]!, (a + b) >> 4)
      if (word(values, probes.out!) !== a + b) errors.push(`${a}+${b} 输出`)
    }
  }
  return errors
}

for (const arch of ARCHES) {
  describe(arch, () => {
    for (let v = 0; v < 4; v++) {
      const A = bit(v, 1)
      const B = bit(v, 0)
      test(`异或 ${A} ⊕ ${B}：门级、配置位、分支、输出`, () => {
        const design = getDesign(arch, 'xor')
        const values = propagate(design, { A, B }, {})
        const expected = A === B ? 0 : 1
        assert.equal(values[design.probes.lut![0]!], expected)
        assert.equal(values[design.probes.out![0]!], expected)

        const lut = design.roles.get('lut:0')!
        const chosen = selection({ design, stage: at('xor', 'branch'), values }, lut)!
        const size = arch === 'amd' ? 6 : 4
        assert.equal(chosen.address, 2 ** size - 4 + A + 2 * B, '未用的地址端接 1')
        assert.equal(child(lut, `bit${chosen.address}`).value, expected)
        assert.equal(chosen.path.size, size + 1, '一条路径只含一个配置位和每级一个选择器')
        for (const m of chosen.path) assert.equal(values[m.ports.find((p) => p.dir === 'out')!.net], expected, m.id)
      })
    }

    test('加法：256 组输入的每位进位入、和、进位出与最终输出', () => {
      assert.deepEqual(adderErrors(getDesign(arch, 'adder')), [])
    })

    test('默认算式 0111 + 0001 = 1000', () => {
      const design = getDesign(arch, 'adder')
      const values = propagate(design, adderInputs(0b0111, 0b0001), {})
      assert.equal(word(values, design.probes.sum!).toString(2), '1000')
      assert.deepEqual(design.probes.cout!.map((id) => values[id]), [1, 1, 1, 0])
    })

    test('计数器：16 状态 × EN × CLR 的 D、采样、两种边沿与保持', () => {
      const design = getDesign(arch, 'counter')
      const { probes } = design
      for (let q = 0; q < 16; q++) {
        for (const EN of [0, 1] as const) {
          for (const CLR of [0, 1] as const) {
            const start: Registers = Object.fromEntries([0, 1, 2, 3].map((i) => [`s${i}`, bit(q, i)]))
            const low = settle(design, { CLK: 0, EN, CLR }, start)
            let values = propagate(design, { CLK: 0, EN, CLR }, low)
            assert.equal(word(values, probes.q!), q, '低电平保持')
            assert.equal(word(values, probes.d!), (q + 1) % 16, 'D 引脚总是 Q+1')
            for (let i = 0; i < 4; i++) {
              const cin = q % 2 ** i === 2 ** i - 1 && i > 0 ? 1 : 0
              assert.equal(values[probes.cin![i]!], cin)
              assert.equal(values[probes.cout![i]!], q % 2 ** (i + 1) === 2 ** (i + 1) - 1 ? 1 : 0)
              assert.equal(values[probes.faSum![i]!], values[probes.sum![i]!])
              assert.equal(values[probes.faCout![i]!], values[probes.cout![i]!])
            }
            const expected = CLR ? 0 : EN ? (q + 1) % 16 : q
            assert.equal(word(values, probes.next!), expected)
            assert.equal(word(values, probes.captured!), expected)

            values = propagate(design, { CLK: 1, EN, CLR }, low)
            assert.equal(word(values, probes.q!), q, '采样瞬间 Q 尚未翻转')
            const high = settle(design, { CLK: 1, EN, CLR }, low)
            assert.equal(word(propagate(design, { CLK: 1, EN, CLR }, high), probes.q!), expected)

            for (const en of [0, 1] as const) for (const clr of [0, 1] as const) {
              const edited = settle(design, { CLK: 1, EN: en, CLR: clr }, high)
              assert.equal(word(propagate(design, { CLK: 1, EN: en, CLR: clr }, edited), probes.q!), expected, '高电平改输入不穿通')
            }
            const fallen = settle(design, { CLK: 0, EN, CLR }, high)
            assert.equal(word(propagate(design, { CLK: 0, EN, CLR }, fallen), probes.q!), expected, '下降沿保持')
          }
        }
      }
    })

    test('计数器：连续走完 16 状态并从 1111 回绕', () => {
      const design = getDesign(arch, 'counter')
      let regs = settle(design, { CLK: 0, EN: 1, CLR: 0 }, {})
      for (let edge = 1; edge <= 33; edge++) {
        regs = settle(design, { CLK: 1, EN: 1, CLR: 0 }, regs)
        assert.equal([0, 1, 2, 3].reduce((n, i) => n + regs[`s${i}`]! * 2 ** i, 0), edge % 16)
        regs = settle(design, { CLK: 0, EN: 1, CLR: 0 }, regs)
      }
    })
  })
}

describe('硬件映射', () => {
  const sliceOf = (arch: Arch, role: string) => closest(getDesign(arch, 'adder').roles.get(role)!, 'slice')!.id

  test('AMD 四位同在一个 Slice，最终进位经上方 CLB 引出', () => {
    assert.equal(new Set([0, 1, 2, 3].map((i) => sliceOf('amd', `carry:${i}`))).size, 1)
    assert.equal(sliceOf('amd', 'exit'), 'chip/helper/s0')
    const design = getDesign('amd', 'adder')
    const main = design.modules.get('chip/block/s0')!
    assert.equal(port(design.modules.get('chip/helper/s0')!, 'CIN'), port(main, 'COUT'))
  })

  test('ECP5 两主两辅，低两位进位经 FCO 进入高两位', () => {
    const slices = ['cinit', 'carry:0', 'carry:1', 'carry:2', 'carry:3', 'exit'].map((role) => sliceOf('ecp5', role).slice(-2))
    assert.deepEqual(slices, ['s0', 's1', 's1', 's2', 's2', 's3'])
    const design = getDesign('ecp5', 'adder')
    const slice = (i: number) => design.modules.get(`chip/block/s${i}`)!
    for (let i = 0; i < 3; i++) assert.equal(port(slice(i), 'FCO'), port(slice(i + 1), 'FCI'))
  })

  test('每种架构每块含有手册列出的资源', () => {
    for (const [arch, slices, luts, storage] of [['amd', 2, 4, 8], ['ecp5', 4, 2, 2]] as const) {
      for (const example of EXAMPLES) {
        const design = getDesign(arch, example)
        for (const block of [design.roles.get('block')!, design.idle]) {
          assert.equal(block.children.length, slices)
          for (const s of block.children) {
            assert.equal(s.children.filter((c) => c.kind === 'lut').length, luts)
            assert.equal(s.children.filter((c) => c.kind === 'ff').length, storage)
          }
        }
      }
    }
  })

  test('异或只把实际选用的资源标成已使用', () => {
    const amd = getDesign('amd', 'xor')
    const used = (id: string, name: string) => amd.modules.get(`chip/block/s0/${id}`)!.ports.find((p) => p.name === name)!.used
    assert.equal(used('lutA', 'O6'), true)
    assert.equal(used('lutA', 'O5'), false)
    assert.equal(used('f7a', 'O'), false)
    assert.equal(used('carry4', 'S0'), false)
  })

  test('O5 只在 AMD 计数器中作为 DI', () => {
    for (const example of EXAMPLES) {
      const lut = getDesign('amd', example).modules.get('chip/block/s0/lutA')!
      assert.equal(lut.ports.find((p) => p.name === 'O5')!.used, example === 'counter', example)
    }
  })
})

describe('阶段', () => {
  const shared: Record<string, string[]> = {
    xor: ['lut', 'out'],
    adder: ['p', 'cin', 'sum', 'cout', 'out', 'exit'],
    counter: ['p', 'cin', 'sum', 'cout', 'q', 'd', 'next', 'captured', 'out'],
  }
  for (const example of EXAMPLES) {
    test(`${example}：两套架构在同一阶段显示同一组值`, () => {
      const vectors: Record<string, Bit>[] = []
      if (example === 'xor') for (let v = 0; v < 4; v++) vectors.push({ A: bit(v, 0), B: bit(v, 1) })
      if (example === 'adder') for (let v = 0; v < 256; v++) vectors.push(adderInputs(v & 15, v >> 4))
      if (example === 'counter') for (let v = 0; v < 128; v++) vectors.push({ CLK: bit(v, 0), EN: bit(v, 1), CLR: bit(v, 2) })
      vectors.forEach((inputs, v) => {
        const regs: Registers = {}
        for (let i = 0; i < 4; i++) regs[`s${i}`] = regs[`m${i}`] = bit(v >> 3, i)
        const designs = ARCHES.map((arch) => getDesign(arch, example))
        const values = designs.map((design) => propagate(design, inputs, regs))
        for (let stage = 0; stage < STAGES[example].length; stage++) {
          const shown = designs.map((design, k) => shared[example]!.flatMap((name) =>
            design.probes[name]!.map((id) => display({ design, stage, values: values[k]! }, id))))
          assert.deepEqual(shown[0], shown[1], `阶段 ${STAGES[example][stage]!.id}`)
        }
      })
    })
  }

  test('每个阶段在两套架构里都有承担它的模块', () => {
    for (const arch of ARCHES) for (const example of EXAMPLES) for (const stage of STAGES[example]) {
      assert.ok(getDesign(arch, example).roles.has(stage.role), `${arch}/${example}/${stage.id}`)
    }
  })

  test('没有任何门的输出早于它的输入出现', () => {
    for (const arch of ARCHES) for (const example of EXAMPLES) {
      const design = getDesign(arch, example)
      const state = new Set(design.latches.flatMap((l) => [l.q, l.qn]))
      for (const gate of design.order) {
        if (state.has(gate.out)) continue
        for (const id of gate.inputs) assert.ok(design.nets[gate.out]!.at >= design.nets[id]!.at, gate.module.id)
      }
    }
  })
})

describe('反证：故障必须被加法检查发现', () => {
  for (const arch of ARCHES) {
    const build = () => (arch === 'amd' ? buildAmd : buildEcp5)('adder')

    test(`${arch}：翻转一个 INIT 位`, () => {
      const design = build()
      const size = arch === 'amd' ? 6 : 4
      const config = child(design.roles.get('lut:1')!, `bit${2 ** size - 3}`)
      const net = design.nets[port(config, 'Q')]!
      net.constant = (1 - net.constant!) as Bit
      assert.ok(adderErrors(design).length > 0)
    })

    test(`${arch}：断开低两位到高两位的进位`, () => {
      const design = build()
      const carry = design.probes.cout![1]!
      const open = design.nets.push({ id: design.nets.length, name: '断线', at: 0, used: true, constant: 0 }) - 1
      for (const gate of design.order) gate.inputs = gate.inputs.map((id) => (id === carry ? open : id))
      assert.ok(adderErrors(design).length > 0)
    })
  }
})
