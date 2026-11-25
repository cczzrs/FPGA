import './style.css'
import { View } from './scene/view.ts'
import { Session } from './session.ts'
import { UI } from './ui.ts'

const session = new Session()
let view: View | null = null
const ui = new UI(session, () => view?.reset())

try {
  view = new View(document.getElementById('viewport')!, document.getElementById('labels')!, {
    open: (id) => session.open(id),
    info: (text) => ui.info(text),
  })
} catch (error) {
  console.error(error)
  document.getElementById('viewport')!.dataset.failed = 'true'
}

let frame = 0
let last = 0

function loop(now: number): void {
  frame = 0
  // 低帧率时照实计时。转入后台时 last 清零；一帧至多前进一个阶段，所以不会连跳。
  const elapsed = last ? Math.min((now - last) / 1000, 1) : 0
  last = now
  session.tick(elapsed)
  if (!session.run.playing) return
  view?.animate(session.run.progress)
  ui.progress()
  schedule()
}

function schedule(): void {
  if (session.run.playing && !document.hidden) {
    if (!frame) frame = requestAnimationFrame(loop)
  } else {
    cancelAnimationFrame(frame)
    frame = 0
    last = 0
  }
}

function update(): void {
  ui.update()
  view?.update(session.result, session.focused, session.run.playing, session.run.progress)
  schedule()
}

session.subscribe(update)
document.addEventListener('visibilitychange', () => {
  last = 0
  schedule()
})

update()
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) session.play()

if (import.meta.env.DEV) Object.assign(window, { fpga: { session, inspect: () => view?.inspect() } })
