import * as THREE from 'three'
import type { Shape } from './layout.ts'

/** 单位大小、沿地面朝上拉伸的原理图符号：x、z ∈ [-0.5, 0.5]，y ∈ [0, 1]。 */
export function createShapes(): Record<Shape, THREE.BufferGeometry> {
  const extrude = (shapes: THREE.Shape | THREE.Shape[]) =>
    new THREE.ExtrudeGeometry(shapes, { depth: 1, bevelEnabled: false, curveSegments: 14 }).rotateX(-Math.PI / 2)
  const polygon = (...points: [number, number][]) => new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))

  const and = new THREE.Shape()
  and.moveTo(-0.5, -0.5)
  and.lineTo(0, -0.5)
  and.absellipse(0, 0, 0.5, 0.5, -Math.PI / 2, Math.PI / 2, false, 0)
  and.lineTo(-0.5, 0.5)
  and.closePath()

  const shield = (left: number) => {
    const s = new THREE.Shape()
    s.moveTo(left, -0.5)
    s.quadraticCurveTo(0.2, -0.5, 0.5, 0)
    s.quadraticCurveTo(0.2, 0.5, left, 0.5)
    s.quadraticCurveTo(left + 0.3, 0, left, -0.5)
    return s
  }
  const arc = new THREE.Shape()
  arc.moveTo(-0.5, -0.5)
  arc.quadraticCurveTo(-0.2, 0, -0.5, 0.5)
  arc.lineTo(-0.43, 0.5)
  arc.quadraticCurveTo(-0.13, 0, -0.43, -0.5)
  arc.closePath()
  const bubble = new THREE.Shape()
  bubble.absarc(0.38, 0, 0.12, 0, Math.PI * 2, false)

  return {
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    mux: extrude(polygon([-0.5, -0.5], [0.5, -0.3], [0.5, 0.3], [-0.5, 0.5])),
    and: extrude(and),
    or: extrude(shield(-0.5)),
    xor: extrude([shield(-0.34), arc]),
    not: extrude([polygon([-0.5, -0.5], [0.27, 0], [-0.5, 0.5]), bubble]),
  }
}
