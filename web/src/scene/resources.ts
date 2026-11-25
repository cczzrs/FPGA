import * as T from 'three'
import { resourceTree, type ResourceNode } from '../logic/hierarchy.ts'
import type { Family, SceneAsset } from './types.ts'

export function chipResources(asset: SceneAsset, family: Family, selection?: ResourceNode) {
  const entries: { node: ResourceNode; size: [number, number, number]; height: number }[] = []
  const visit = (n: ResourceNode) => {
    if (n.inspect && n.inspect.x !== undefined && n.inspect.z !== undefined) {
      const macro = n.kind === 'ram' || n.kind === 'dsp'
      const size: [number, number, number] = macro
        ? family === 'amd'
          ? [0.51, 0.17, 0.89]
          : [0.99, 0.17, 0.43]
        : n.kind === 'pin'
          ? [0.1, 0.08, 0.1]
          : [0.13, 0.11, 0.13]
      entries.push({ node: n, size, height: macro ? 0.51 : n.kind === 'pin' ? -0.1 : 0.35 })
    } else n.children?.().forEach(visit)
  }
  resourceTree(family)
    .children?.()
    .filter((n) => ['chip/ram', 'chip/dsp', 'chip/io'].includes(n.id))
    .forEach(visit)
  const hit = new T.InstancedMesh(
    new T.BoxGeometry(1, 1, 1),
    new T.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    entries.length
  )
  const q = new T.Quaternion(),
    m = new T.Matrix4()
  entries.forEach(({ node, size, height }, i) =>
    hit.setMatrixAt(
      i,
      m.compose(new T.Vector3(node.inspect!.x, height, node.inspect!.z), q, new T.Vector3(...size))
    )
  )
  hit.userData.resourceIds = entries.map((e) => e.node.id)
  hit.computeBoundingSphere()
  asset.group.add(hit)
  const info = selection?.inspect
  if (info && info.x !== undefined && info.z !== undefined) {
    const x = info.x,
      z = info.z,
      y = info.kind === 'pin' ? 0.12 : 0.75
    const ring = new T.Mesh(
      new T.RingGeometry(0.2, 0.26, 32),
      new T.MeshBasicMaterial({ color: '#d3ff8c', side: T.DoubleSide, depthTest: false })
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.set(x, y, z)
    ring.renderOrder = 9
    asset.group.add(ring)
    asset.labels.unshift({
      text: info.name,
      at: new T.Vector3(x, y + 0.06, z),
      color: '#d0ed92',
      priority: 20
    })
  }
}
