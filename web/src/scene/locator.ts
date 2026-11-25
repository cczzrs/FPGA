import { families } from '../logic/simulator.ts'
import type { Family, Location } from './types.ts'

/** Small top view that keeps the enclosing outline visible while inspecting a child. */
export function parentOutline(family: Family, loc: Location) {
  const f = families[family]
  const marks: string[] = []
  const box = (x: number, y: number, w: number, h: number, selected: boolean) => {
    marks.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx=".5" fill="${selected ? '#c6eb93' : '#52645a'}"/>`
    )
  }
  if (loc.level === 'block') {
    for (let y = 0; y < 9; y++)
      for (let x = 0; x < 11; x++) {
        box(5 + x * 5, 3 + y * 3, 4, 2, x === 4 && y === (family === 'amd' ? 5 : 4))
      }
  } else if (loc.level === 'slice') {
    const w = 54 / f.slices
    for (let i = 0; i < f.slices; i++)
      box(5 + i * w, 6 + (family === 'amd' && i === 0 ? 3 : 0), w - 3, 17, loc.slice === i)
  } else if (loc.level === 'unit') {
    const pitch = 24 / f.lanes,
      lane = loc.bit % f.lanes
    for (let i = 0; i < f.lanes; i++) {
      const y = 3 + (f.lanes - 1 - i) * pitch
      box(6, y, 16, pitch - 1, loc.unit === 'lut' && lane === i)
      box(34, y, 6, pitch - 1, loc.unit === 'carry' && lane === i)
      box(46, y, 10, pitch - 1, loc.unit === 'ff' && lane === i)
    }
    box(25, 10, 6, 10, loc.unit === 'mux')
  } else if (loc.unit === 'lut') {
    for (let i = 0; i < f.width; i++) {
      const count = Math.min(4, f.width - i),
        pitch = 23 / count
      for (let j = 0; j < count; j++)
        box(
          5 + i * 9,
          4 + j * pitch,
          6,
          pitch - 1.5,
          i === (loc.tier ?? 1) - 1 &&
            j === Math.floor(((loc.muxIndex ?? 0) * count) / (1 << (f.width - i - 1)))
        )
    }
  } else if (loc.unit === 'carry') {
    const pitch = 53 / f.lanes
    for (let i = 0; i < f.lanes; i++) box(5 + i * pitch, 8, pitch - 2, 15, i === loc.bit % f.lanes)
  } else {
    box(6, 9, 13, 13, false)
    box(23, 7, 17, 17, true)
    box(44, 9, 12, 13, loc.unit === 'ff')
  }
  return (
    '<svg viewBox="0 0 64 32" aria-hidden="true"><rect x="1" y="1" width="62" height="30" rx="3" stroke="#809389" fill="#1e2822"/>' +
    marks.join('') +
    '</svg>'
  )
}
