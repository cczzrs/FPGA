import type { Group, Vector3 } from 'three'

export type Family = 'amd' | 'ecp5'
export type Demo = 'xor' | 'adder' | 'counter'
export type Level = 'chip' | 'block' | 'slice' | 'unit' | 'gate'
export type Unit = 'lut' | 'mux' | 'carry' | 'ff'
export interface Location {
  level: Level
  slice: number
  unit: Unit
  bit: number
  tier?: number
  muxIndex?: number
  secondaryFF?: boolean
  muxName?: string
  block?: string
  probe?: string
}
export type Jump = Partial<Location> & { level: Level }
export interface SceneLabel {
  text: string
  at: Vector3
  color?: string
  signal?: string
  watch?: string[]
  jump?: Jump
  probe?: string
  priority?: number
}
export interface SceneRoute {
  points: Vector3[]
  signal: string
}
export interface SceneAsset {
  group: Group
  labels: SceneLabel[]
  routes: SceneRoute[]
  /** Camera direction, looking from this octant towards the model. */
  eye?: [number, number, number]
}
