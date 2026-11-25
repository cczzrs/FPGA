type Panel = 'tree' | 'sim'
type Rect = { x: number; y: number; w: number; h: number; hidden: boolean; folded: boolean }
const panels: Panel[] = ['tree', 'sim']
const key = 'fabric-atlas.desktop.v1'
const defaults = (): Record<Panel, Rect> => ({
  tree: { x: 0, y: 0, w: 1, h: 0.46, hidden: false, folded: false },
  sim: { x: 0, y: 0.47, w: 1, h: 0.53, hidden: false, folded: false }
})
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
export function setupDesktop() {
  const root = document.getElementById('desktop')!,
    desk = document.getElementById('module-desk')!
  const split = document.getElementById('desktop-split')!,
    mobile = matchMedia('(max-width: 800px)')
  let layout = defaults(),
    ratio = 0.6,
    wires = true,
    top: Panel = 'tree'
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    if (
      saved &&
      panels.every((p) => ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(saved.windows?.[p]?.[k])))
    ) {
      layout = saved.windows
      ratio = Number.isFinite(saved.ratio) ? clamp(saved.ratio, 0.32, 0.75) : ratio
      wires = saved.wires !== false
    }
  } catch {
    /* Storage can be unavailable in a private browser. */
  }
  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify({ windows: layout, ratio, wires }))
    } catch {}
  }
  const node = (p: Panel) => document.getElementById(p + '-window')!
  function draw() {
    const dw = Math.max(1, desk.clientWidth),
      dh = Math.max(1, desk.clientHeight)
    for (const p of panels) {
      const r = layout[p],
        el = node(p)
      const w = clamp(r.w * dw, Math.min(255, dw), dw),
        h = clamp(r.h * dh, Math.min(135, dh), dh)
      el.style.setProperty('--win-left', clamp(r.x * dw, 0, Math.max(0, dw - w)) + 'px')
      el.style.setProperty('--win-top', clamp(r.y * dh, 0, Math.max(0, dh - (r.folded ? 36 : h))) + 'px')
      el.style.setProperty('--win-width', w + 'px')
      el.style.setProperty('--win-height', (r.folded ? 36 : h) + 'px')
      el.dataset.folded = String(r.folded && !mobile.matches)
      el.dataset.hidden = String(r.hidden && !mobile.matches)
      el.style.zIndex = top === p ? '2' : '1'
      el.querySelector('[data-window=collapse]')?.setAttribute('aria-expanded', String(!r.folded))
    }
    root.style.setProperty('--scene-share', String(ratio))
    split.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
    const showWires = mobile.matches
      ? root.dataset.mobile === 'wires' || (root.dataset.mobile === 'scene' && wires)
      : wires
    document.getElementById('wire-drawer')!.hidden = !showWires
    root.querySelectorAll<HTMLElement>('.desktop-rail [data-dock]').forEach((b) => {
      const p = b.dataset.dock
      const on = mobile.matches
        ? p === root.dataset.mobile
        : p === 'scene' ||
          (p === 'wires' ? wires : panels.includes(p as Panel) && !layout[p as Panel].hidden)
      if (p !== 'reset') b.setAttribute('aria-pressed', String(on))
    })
  }
  function open(which: string) {
    if (which === 'reset') {
      layout = defaults()
      ratio = 0.6
      wires = true
      top = 'tree'
      root.dataset.mobile = 'scene'
    } else if (mobile.matches) {
      root.dataset.mobile = which
      if (panels.includes(which as Panel)) {
        layout[which as Panel].hidden = false
        layout[which as Panel].folded = false
      }
      if (which === 'wires') wires = true
    } else if (which === 'wires') wires = !wires
    else if (panels.includes(which as Panel)) {
      const p = which as Panel,
        r = layout[p]
      if (r.hidden || r.folded) {
        r.hidden = false
        r.folded = false
      } else r.hidden = true
      top = p
    } else if (which === 'scene') document.querySelector<HTMLButtonElement>('[data-action=home]')?.click()
    draw()
    save()
  }
  root.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-dock],[data-window]')
    if (!target) return
    if (target.dataset.dock === 'wires' && target.closest('#wire-drawer')) {
      wires = false
      if (mobile.matches) root.dataset.mobile = 'scene'
      draw()
      save()
      return
    }
    if (target.dataset.dock) {
      open(target.dataset.dock)
      return
    }
    const p = target.closest<HTMLElement>('[data-panel]')!.dataset.panel as Panel
    const r = layout[p]
    if (target.dataset.window === 'collapse') r.folded = !r.folded
    else r.hidden = true
    if (mobile.matches) root.dataset.mobile = 'scene'
    draw()
    save()
  })
  function changeSplit(initial: number, dx: number) {
    const total = root.clientWidth - 78
    ratio = clamp(
      initial + dx / total,
      Math.min(0.44, 300 / total),
      Math.max(0.5, Math.min(0.75, 1 - 285 / total))
    )
    draw()
  }
  function adjust(p: Panel, start: Rect, dx: number, dy: number, resize: boolean) {
    const w = Math.max(1, desk.clientWidth),
      h = Math.max(1, desk.clientHeight),
      r = layout[p]
    if (resize) {
      r.w = clamp(start.w + dx / w, Math.min(255 / w, 1), 1 - start.x)
      r.h = clamp(start.h + dy / h, Math.min(135 / h, 1), 1 - start.y)
    } else {
      r.x = clamp(start.x + dx / w, 0, 1 - start.w)
      r.y = clamp(start.y + dy / h, 0, 1 - (r.folded ? 36 / h : start.h))
    }
    draw()
  }
  root.addEventListener('pointerdown', (e) => {
    if (mobile.matches || e.button !== 0) return
    const target = e.target as HTMLElement,
      panel = target.closest<HTMLElement>('[data-panel]')
    if (panel) {
      top = panel.dataset.panel as Panel
      draw()
    }
    const handle = target.closest<HTMLElement>('[data-move],[data-resize],#desktop-split')
    if (!handle) return
    const p = (handle.dataset.move || handle.dataset.resize) as Panel,
      start = p ? { ...layout[p] } : null
    const x = e.clientX,
      y = e.clientY,
      initial = ratio
    handle.setPointerCapture(e.pointerId)
    e.preventDefault()
    const move = (ev: PointerEvent) => {
      if (start) adjust(p, start, ev.clientX - x, ev.clientY - y, !!handle.dataset.resize)
      else changeSplit(initial, ev.clientX - x)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('lostpointercapture', end)
      save()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('lostpointercapture', end)
  })
  root.addEventListener('keydown', (e) => {
    if (mobile.matches || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    const handle = (e.target as HTMLElement).closest<HTMLElement>(
      '[data-move],[data-resize],#desktop-split'
    )
    if (!handle) return
    const step = e.shiftKey ? 30 : 10,
      dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
      dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
    const p = (handle.dataset.move || handle.dataset.resize) as Panel
    if (p) adjust(p, { ...layout[p] }, dx, dy, !!handle.dataset.resize)
    else changeSplit(ratio, dx)
    e.preventDefault()
    save()
  })
  const observer = new ResizeObserver(draw)
  observer.observe(desk)
  mobile.addEventListener('change', draw)
  draw()
  return {
    showWires() {
      wires = true
      if (mobile.matches) root.dataset.mobile = 'wires'
      draw()
      save()
    }
  }
}
