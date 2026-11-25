import test from 'node:test'
import assert from 'node:assert/strict'
import { Matrix4, Vector3 } from 'three'
import { resourceIdFor, resourceTree, sampleBlock } from '../src/logic/hierarchy.ts'
import { buildChip } from '../src/scene/chip.ts'

function walk(node, visit) {
  visit(node)
  for (const child of node.children?.() ?? []) {
    assert.equal(child.id.slice(0, child.id.lastIndexOf('/')), node.id)
    walk(child, visit)
  }
}

function firstBlock(root) {
  return root
    .children()
    .find((node) => node.kind === 'logic-array')
    .children()[0]
}

for (const family of ['amd', 'ecp5']) {
  const amd = family === 'amd'
  const slices = amd ? 2 : 4
  const lanes = amd ? 4 : 2
  const width = amd ? 6 : 4

  test(family + ' enumerates exactly the individual logic sites in the illustrated window', () => {
    const root = resourceTree(family)
    assert.equal(root.id, 'chip')
    assert.strictEqual(root.children(), root.children())
    assert.deepEqual(
      root.children().map((node) => node.id),
      ['chip/logic', 'chip/ram', 'chip/dsp', 'chip/clock', 'chip/io', 'chip/routing']
    )
    const [sample, remaining] = root.children()[0].children()
    assert.equal(sample.id, 'chip/logic/' + sampleBlock(family))
    assert.equal(sample.jump.block, amd ? 'X4Y5' : 'X4Y4')
    assert.equal(remaining.id, 'chip/logic/rows')
    const sites = [sample, ...remaining.children().flatMap((row) => row.children())]
    const names = sites.map((site) => site.jump.block)
    assert.equal(sites.length, amd ? 72 : 77)
    assert.equal(new Set(names).size, names.length)
    for (let y = 0; y < 9; y++)
      for (let x = 0; x < 11; x++) {
        const present = amd ? ![2, 5, 8].includes(x) : ![2, 6].includes(y)
        assert.equal(names.includes(`X${x}Y${y}`), present)
      }
    for (const site of sites) {
      assert.equal(resourceIdFor(family, site.jump), site.id)
      assert.equal(site.children().length, slices)
      for (const slice of site.children()) {
        assert.equal(slice.jump.block, site.jump.block)
        assert.equal(resourceIdFor(family, slice.jump), slice.id)
        const units = slice.children()
        assert.equal(units.filter((n) => n.kind === 'lut').length, lanes)
        assert.equal(units.filter((n) => n.kind === 'ff').length, amd ? 8 : 2)
        assert.equal(units.filter((n) => n.kind === 'mux').length, amd ? 3 : 2)
        assert.equal(units.filter((n) => n.kind === 'carry').length, 1)
      }
    }
  })

  test(family + ' exposes every configuration bit, selection tier and independent equivalent gate', () => {
    const root = resourceTree(family)
    const first = firstBlock(root)
    const seen = new Set()
    let configBits = 0
    walk(first, (node) => {
      assert.ok(!seen.has(node.id), node.id)
      seen.add(node.id)
      if (node.kind === 'config-bit') {
        configBits++
        const address = Number(node.id.split('/M').at(-1))
        assert.equal(node.jump.tier, 1)
        assert.equal(node.jump.muxIndex, address >> 1)
        assert.equal(node.jump.probe, address % 2 ? 'ghigh' : 'glo')
      } else if (node.jump) assert.equal(resourceIdFor(family, node.jump), node.id)
    })
    assert.equal(configBits, slices * lanes * (1 << width))
    for (const slice of first.children()) {
      for (const lut of slice.children().filter((n) => n.kind === 'lut')) {
        const network = lut.children().find((n) => n.kind === 'lut-network')
        assert.equal(network.children().length, width)
        for (const [tier, layer] of network.children().entries()) {
          assert.equal(layer.children().length, 1 << (width - tier - 1))
          for (const mux of layer.children()) {
            assert.deepEqual(
              mux.children().map((n) => n.jump.probe),
              ['gnot', 'glo', 'ghigh', 'gor']
            )
          }
        }
      }
      const flipflops = slice.children().filter((n) => n.kind === 'ff')
      assert.equal(flipflops.filter((n) => n.jump.secondaryFF).length, amd ? 4 : 0)
      assert.ok(
        flipflops[0]
          .children()[0]
          .children()
          .some((n) => n.jump.probe === 'gqb')
      )
      const chain = slice.children().find((n) => n.kind === 'carry')
      assert.equal(chain.children().length, lanes)
      const carryGates = chain
        .children()[0]
        .children()
        .map((n) => n.jump.probe)
      assert.equal(carryGates.includes('ggen'), !amd)
      assert.ok(carryGates.includes('gco'))
    }
  })

  test(family + ' peripheral leaves point to geometry in the actual overview scene', () => {
    const tree = resourceTree(family)
    const { group } = buildChip(family, 'xor')
    const pos = new Vector3(),
      matrix = new Matrix4(),
      centers = []
    group.traverse((obj) => {
      if (!obj.isInstancedMesh) return
      for (let n = 0; n < obj.count; n++) {
        obj.getMatrixAt(n, matrix)
        pos.setFromMatrixPosition(matrix)
        centers.push([pos.x, pos.z])
      }
    })
    const counts = {}
    for (const resource of tree.children().slice(1)) {
      walk(resource, (node) => {
        if (node.children) return
        const { kind, description, x, z } = node.inspect
        counts[kind] = (counts[kind] ?? 0) + 1
        assert.ok(description)
        assert.ok(
          centers.some(([cx, cz]) => Math.abs(x - cx) < 0.00002 && Math.abs(z - cz) < 0.00002),
          node.id + ' ' + x + ' ' + z
        )
      })
    }
    assert.deepEqual(counts, {
      ram: amd ? 5 : 6,
      dsp: amd ? 5 : 6,
      clock: amd ? 12 : 3,
      io: 94,
      pin: 114,
      routing: 164
    })
  })
}
