import * as T from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { netColor } from '../logic/signals.ts'
import { routeWires } from './routing.ts'
import type { Jump, SceneAsset, SceneLabel, SceneRoute } from './types.ts'

type Values = Record<string, number | undefined>
type Track = { route: SceneRoute; curve: T.CurvePath<T.Vector3>; packet: T.Mesh }
type Caption = { data: SceneLabel; el: HTMLElement }
export function disposeGroup(group: T.Object3D) {
  const geometry = new Set<T.BufferGeometry>(),
    materials = new Set<T.Material>(),
    textures = new Set<T.Texture>()
  group.traverse((o) => {
    const mesh = o as T.Mesh
    if (mesh.geometry) geometry.add(mesh.geometry)
    if (mesh.material)
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m)
    if (o instanceof T.InstancedMesh) o.dispose()
  })
  materials.forEach((m) => {
    for (const val of Object.values(m)) if (val instanceof T.Texture) textures.add(val)
    m.dispose()
  })
  textures.forEach((t) => t.dispose())
  geometry.forEach((g) => g.dispose())
}

function lines(routes: SceneRoute[], width: number, opacity: number) {
  const coords: number[] = [],
    colors: number[] = []
  const unique = new Set<string>()
  for (const route of routes) {
    const color = new T.Color(netColor(route.signal))
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1],
        b = route.points[i]
      if (a.distanceToSquared(b) < 0.000001) continue
      const keys = [a, b]
        .map((p) =>
          p
            .toArray()
            .map((v) => v.toFixed(4))
            .join(',')
        )
        .sort()
      const key = route.signal + keys.join('|')
      if (unique.has(key)) continue
      unique.add(key)
      coords.push(a.x, a.y + 0.032, a.z, b.x, b.y + 0.032, b.z)
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b)
    }
  }
  const geo = new LineSegmentsGeometry()
  geo.setPositions(coords.length ? coords : [0, 0, 0, 0, 0, 0])
  geo.setColors(colors.length ? colors : [1, 1, 1, 1, 1, 1])
  const mat = new LineMaterial({
    color: 0xffffff,
    vertexColors: true,
    linewidth: width,
    transparent: opacity < 1,
    opacity,
    depthWrite: false
  })
  const mesh = new LineSegments2(geo, mat)
  mesh.frustumCulled = false
  mesh.visible = !!coords.length
  return mesh
}

export class Stage {
  private renderer: T.WebGLRenderer
  private scene = new T.Scene()
  private camera = new T.OrthographicCamera(-6, 6, 4, -4, 0.02, 150)
  private controls: OrbitControls
  private asset?: SceneAsset
  private traces = new T.Group()
  private hot = new T.Group()
  private captions: Caption[] = []
  private portCaptions: Caption[] = []
  private tracks: Track[] = []
  private picks: T.Object3D[] = []
  private tint: T.Mesh[] = []
  private overlay: HTMLElement
  private active = new Set<string>()
  private playing = false
  private phaseTime = 0
  private previous = 0
  private speed = 1
  private width = 1
  private height = 1
  private fitted = 5
  private ray = new T.Raycaster()
  private mouseDown = { x: 0, y: 0 }
  private frame = 0
  private dirty = true
  private resize: ResizeObserver
  private target = new T.Vector3()
  private grid: T.GridHelper
  private floor: T.Mesh
  constructor(
    private host: HTMLElement,
    private jump: (j: Jump) => void,
    private probe: (id: string) => void,
    private wire: (id: string) => void,
    private resource: (id: string) => void
  ) {
    this.renderer = new T.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setClearColor(0, 0)
    this.renderer.outputColorSpace = T.SRGBColorSpace
    const canvas = this.renderer.domElement
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', '可旋转的 FPGA 三维结构，模块也可通过右侧层级导航选择')
    host.prepend(canvas)
    this.overlay = document.createElement('div')
    this.overlay.className = 'labels-3d'
    host.append(this.overlay)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.13
    this.controls.enablePan = true
    this.controls.maxPolarAngle = Math.PI * 0.475
    this.controls.minZoom = 0.38
    this.controls.maxZoom = 7
    this.controls.addEventListener('change', () => {
      this.dirty = true
    })
    this.scene.add(new T.AmbientLight(0xf1fbff, 1.06), new T.HemisphereLight(0xdaf8ff, 0x688369, 1.8))
    const key = new T.DirectionalLight(0xfff3d7, 2.55)
    key.position.set(-5, 9, 6)
    const rim = new T.DirectionalLight(0xa0c9e4, 1.45)
    rim.position.set(5, 4, -5)
    this.scene.add(key, rim, this.traces, this.hot)
    this.grid = new T.GridHelper(90, 96, 0x45615a, 0x45615a)
    const gm = this.grid.material as T.Material
    gm.transparent = true
    gm.opacity = 0.2
    gm.depthWrite = false
    this.scene.add(this.grid)
    const shade = document.createElement('canvas')
    shade.width = shade.height = 128
    const ctx = shade.getContext('2d')!,
      g = ctx.createRadialGradient(64, 64, 5, 64, 64, 64)
    g.addColorStop(0, 'rgba(0,0,0,.88)')
    g.addColorStop(0.6, 'rgba(0,0,0,.54)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 128, 128)
    this.floor = new T.Mesh(
      new T.PlaneGeometry(1, 1),
      new T.MeshBasicMaterial({ map: new T.CanvasTexture(shade), transparent: true, depthWrite: false })
    )
    this.floor.rotation.x = -Math.PI / 2
    this.scene.add(this.floor)
    const hit = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      this.ray.setFromCamera(
        new T.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          (-(e.clientY - rect.top) / rect.height) * 2 + 1
        ),
        this.camera
      )
      const intersection = this.ray.intersectObjects(this.picks, false)[0]
      if (!intersection) return undefined
      const data = intersection.object.userData
      if (data.resourceIds && intersection.instanceId !== undefined)
        return { resourceId: data.resourceIds[intersection.instanceId] }
      if (data.logicTile) {
        const c = Math.round(intersection.point.x / 0.66 + 5),
          r = Math.round(intersection.point.z / 0.6 + 4)
        return { jump: { level: 'block', block: 'X' + c + 'Y' + r, bit: 0, slice: 0 } as Jump }
      }
      return data
    }
    canvas.addEventListener('pointerdown', (e) => {
      this.mouseDown = { x: e.clientX, y: e.clientY }
    })
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || Math.hypot(e.clientX - this.mouseDown.x, e.clientY - this.mouseDown.y) > 5)
        return
      const signal = this.pickWire(e.clientX, e.clientY)
      if (signal) {
        this.wire(signal)
        return
      }
      const pick = hit(e)
      if (pick?.resourceId) this.resource(pick.resourceId)
      else if (pick?.jump) this.jump(pick.jump)
      else if (pick?.probe) this.probe(pick.probe)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!e.buttons) canvas.style.cursor = hit(e) ? 'pointer' : 'grab'
    })
    this.resize = new ResizeObserver(() => {
      this.setSize()
    })
    this.resize.observe(host)
    this.setSize()
    this.animate(0)
  }
  private pickWire(cx: number, cy: number) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const x = cx - rect.left,
      y = cy - rect.top
    let found = '',
      best = 4.5 * 4.5
    const screen = (point: T.Vector3) => {
      const p = point.clone()
      p.y += 0.032
      p.project(this.camera)
      return new T.Vector2(((p.x + 1) * rect.width) / 2, ((1 - p.y) * rect.height) / 2)
    }
    for (const { route } of this.tracks) {
      if (route.signal.startsWith('unused-') || route.signal.startsWith('idle')) continue
      if (this.solo && this.solo !== route.signal) continue
      for (let i = 1; i < route.points.length; i++) {
        const a = screen(route.points[i - 1]),
          b = screen(route.points[i])
        const dx = b.x - a.x,
          dy = b.y - a.y,
          len = dx * dx + dy * dy
        if (len < 1) continue
        const t = ((x - a.x) * dx + (y - a.y) * dy) / len
        if (t < 0.04 || t > 0.96) continue
        const distance = (a.x + t * dx - x) ** 2 + (a.y + t * dy - y) ** 2
        if (distance < best) {
          best = distance
          found = route.signal
        }
      }
    }
    return found
  }
  private solo = ''
  private baseLines?: LineSegments2
  private setSize() {
    this.width = Math.max(1, this.host.clientWidth)
    this.height = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(this.width, this.height, false)
    if (this.asset) this.fit(false)
    this.dirty = true
  }
  private fit(home: boolean) {
    const asset = this.asset!
    const bounds = new T.Box3().setFromObject(asset.group)
    const center = bounds.getCenter(new T.Vector3())
    const extent = bounds.getSize(new T.Vector3())
    this.grid.position.y = bounds.min.y - 0.22
    this.floor.position.set(center.x, bounds.min.y - 0.2, center.z)
    this.floor.scale.set(extent.x * 1.64, extent.z * 1.66, 1)
    const eye = new T.Vector3(...(asset.eye ?? [0.85, 1.3, 1.35])).normalize()
    const right = new T.Vector3().crossVectors(new T.Vector3(0, 1, 0), eye).normalize()
    const up = new T.Vector3().crossVectors(eye, right)
    const projected = (v: T.Vector3) =>
      Math.abs(v.x) * extent.x + Math.abs(v.y) * extent.y + Math.abs(v.z) * extent.z
    const aspect = this.width / this.height
    const chip = asset.group.name.includes('芯片剖面')
    const verticalFill = chip ? 0.94 : 0.84
    this.fitted = Math.max(projected(up) / verticalFill, projected(right) / (0.91 * aspect)) / 2
    this.camera.left = -this.fitted * aspect
    this.camera.right = this.fitted * aspect
    this.camera.top = this.fitted
    this.camera.bottom = -this.fitted
    if (home) {
      this.target.copy(center)
      this.controls.target.copy(center)
      this.camera.position.copy(center).addScaledVector(eye, 30)
      this.camera.zoom = 1
      this.camera.lookAt(center)
      this.controls.update()
    } else {
      const delta = center.clone().sub(this.target)
      this.camera.position.add(delta)
      this.controls.target.add(delta)
      this.target.copy(center)
    }
    this.camera.updateProjectionMatrix()
    this.dirty = true
  }
  home() {
    if (this.asset) this.fit(true)
  }
  zoom(factor: number) {
    this.camera.zoom = T.MathUtils.clamp(
      this.camera.zoom * factor,
      this.controls.minZoom,
      this.controls.maxZoom
    )
    this.camera.updateProjectionMatrix()
    this.dirty = true
  }
  private makeCaption(data: SceneLabel): Caption {
    const pickSignal =
      data.signal &&
      !data.signal.startsWith('unused-') &&
      !data.signal.startsWith('idle') &&
      !data.jump &&
      !data.probe
    const el = document.createElement(data.jump || data.probe || pickSignal ? 'button' : 'span')
    el.className = 'model-label'
    el.style.setProperty('--label-color', data.color || '#9ab9ad')
    if (data.jump) el.addEventListener('click', () => this.jump(data.jump!))
    if (data.probe) el.addEventListener('click', () => this.probe(data.probe!))
    if (pickSignal) el.addEventListener('click', () => this.wire(data.signal!))
    this.overlay.append(el)
    return { data, el }
  }
  show(asset: SceneAsset, preserve: boolean) {
    if (this.asset) {
      this.scene.remove(this.asset.group)
      disposeGroup(this.asset.group)
    }
    disposeGroup(this.traces)
    this.traces.clear()
    disposeGroup(this.hot)
    this.hot.clear()
    asset.routes = routeWires(asset.routes)
    this.asset = asset
    this.picks = []
    this.tint = []
    this.tracks = []
    this.overlay.replaceChildren()
    this.portCaptions = []
    this.captions = asset.labels.map((d) => this.makeCaption(d))
    asset.group.traverse((o) => {
      if (o.userData.jump || o.userData.probe || o.userData.logicTile || o.userData.resourceIds)
        this.picks.push(o)
      if (
        o instanceof T.Mesh &&
        (o.userData.signal || o.userData.watch) &&
        o.material instanceof T.MeshStandardMaterial
      )
        this.tint.push(o)
    })
    this.scene.add(asset.group)
    this.baseLines = lines(asset.routes, 1.7, 0.73)
    this.traces.add(this.baseLines)
    const bead = new T.SphereGeometry(0.052, 8, 6)
    const beadMat = new T.MeshBasicMaterial({ color: 0xebffd5 })
    for (const route of asset.routes) {
      const curve = new T.CurvePath<T.Vector3>()
      for (let i = 1; i < route.points.length; i++)
        if (route.points[i].distanceToSquared(route.points[i - 1]) > 0.000001)
          curve.add(new T.LineCurve3(route.points[i - 1], route.points[i]))
      if (!curve.curves.length) continue
      const packet = new T.Mesh(bead, beadMat)
      packet.visible = false
      this.traces.add(packet)
      this.tracks.push({ route, curve, packet })
    }
    this.fit(!preserve)
  }
  update(values: Values, active: string[], playing: boolean, speed: number, solo = '') {
    this.solo = solo
    this.active = new Set(solo ? [solo] : active)
    if (this.baseLines) this.baseLines.material.opacity = solo ? 0.13 : 0.73
    this.playing = playing
    this.speed = speed
    if (!this.asset) return
    const lit = this.asset.routes.filter(
      (r) => this.active.has(r.signal) && (r.signal === solo || values[r.signal] !== undefined)
    )
    disposeGroup(this.hot)
    this.hot.clear()
    if (lit.length) this.hot.add(lines(lit, solo ? 4 : 3.3, 1))
    for (const entry of this.tracks)
      entry.packet.visible = this.active.has(entry.route.signal) && values[entry.route.signal] !== undefined
    this.tint.forEach((mesh) => {
      const mat = mesh.material as T.MeshStandardMaterial
      const live =
        this.active.has(mesh.userData.signal) ||
        mesh.userData.watch?.some((s: string) => this.active.has(s))
      mat.emissive.set(live ? '#6cac53' : '#000000')
      mat.emissiveIntensity = live ? 0.65 : 0
    })
    this.portCaptions.forEach((c) => c.el.remove())
    this.portCaptions = []
    const unique = new Set<string>()
    for (const t of this.tracks) {
      const signal = t.route.signal
      if (
        !t.packet.visible ||
        unique.has(signal) ||
        (!solo && signal.length > 4 && !signal.includes('[')) ||
        this.captions.some((c) => c.data.signal === signal)
      )
        continue
      unique.add(signal)
      this.portCaptions.push(
        this.makeCaption({
          text: signal,
          signal,
          at: t.curve.getPoint(0.48),
          color: netColor(signal),
          priority: 1
        })
      )
      if (this.portCaptions.length === 2) break
    }
    for (const { data, el } of [...this.captions, ...this.portCaptions]) {
      const signal = data.signal ?? data.watch?.find((s) => this.active.has(s))
      const value = signal ? values[signal] : undefined
      const pair = signal?.includes('[')
      const bus =
        signal &&
        (pair ||
          ['SUM', 'Q', 'D'].includes(signal) ||
          (['A', 'B'].includes(signal) && values.SUM !== undefined))
      const word =
        value === undefined ? '' : bus ? value.toString(2).padStart(pair ? 2 : 4, '0') : String(value)
      el.textContent = data.text + (word ? ' · ' + (data.watch ? signal + '=' : '') + word : '')
      el.classList.toggle('signal-active', !!signal && this.active.has(signal))
    }
    this.dirty = true
  }
  private placeCaptions() {
    const inverse = this.camera.quaternion.clone().invert()
    const axes = this.host.parentElement?.querySelector('.axis svg')
    const paths = axes?.querySelectorAll('path'),
      texts = axes?.querySelectorAll('text')
    for (const [i, dir] of [
      new T.Vector3(0, 1, 0),
      new T.Vector3(1, 0, 0),
      new T.Vector3(0, 0, 1)
    ].entries()) {
      dir.applyQuaternion(inverse)
      paths?.[i]?.setAttribute('d', 'M26 27 L' + (26 + dir.x * 19) + ' ' + (27 - dir.y * 19))
      texts?.[i]?.setAttribute('x', String(24 + dir.x * 25))
      texts?.[i]?.setAttribute('y', String(30 - dir.y * 25))
    }
    const occupied: { x: number; y: number; w: number; h: number }[] = []
    const labels = [...this.captions, ...this.portCaptions].sort(
      (a, b) => (b.data.priority ?? 0) - (a.data.priority ?? 0)
    )
    for (const { data, el } of labels) {
      const p = data.at.clone().project(this.camera)
      const ax = ((p.x + 1) * this.width) / 2,
        ay = ((1 - p.y) * this.height) / 2
      const w = el.offsetWidth || 54,
        h = el.offsetHeight || 22
      const x = ax - 8,
        y = ay - h - 12
      const outside =
        p.z < -1 || p.z > 1 || x < 3 || x + w > this.width - 4 || y < 5 || y + h > this.height - 14
      const hit = occupied.some(
        (r) => x < r.x + r.w + 3 && x + w + 3 > r.x && y < r.y + r.h + 3 && y + h + 3 > r.y
      )
      el.style.visibility = outside || hit ? 'hidden' : 'visible'
      if (!outside && !hit) {
        el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)'
        occupied.push({ x, y, w, h })
      }
    }
  }
  private animate = (time: number) => {
    this.frame = requestAnimationFrame(this.animate)
    const dt = Math.min((time - this.previous) / 1000, 0.08)
    this.previous = time
    if (this.playing) this.phaseTime += dt * 0.73 * this.speed
    this.controls.update()
    if (!this.dirty && !this.playing) return
    for (const { packet, curve } of this.tracks)
      if (packet.visible) {
        packet.position.copy(curve.getPointAt((this.phaseTime + 0.42) % 1))
        packet.position.y += 0.08
      }
    this.renderer.render(this.scene, this.camera)
    if (this.dirty) this.placeCaptions()
    this.dirty = false
  }
  dispose() {
    cancelAnimationFrame(this.frame)
    this.resize.disconnect()
    this.controls.dispose()
    disposeGroup(this.scene)
    this.renderer.dispose()
  }
}
