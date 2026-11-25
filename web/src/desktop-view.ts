import { icon, iconButton, type IconName } from './ui.ts'

function titleBar(panel: string, title: string, mark: IconName) {
  return `<div class="window-head"><h2><button class="grip" data-move="${panel}" title="拖动移动窗口，方向键微调">${icon(mark, 17)}${title}</button></h2>
    <div class="window-actions"><button data-window="collapse" title="折叠或展开${title}" aria-label="折叠或展开${title}">${icon('down', 14)}</button>
    <button data-window="hide" title="隐藏${title}" aria-label="隐藏${title}">${icon('minus', 14)}</button></div></div>`
}
const resizeHandle = (id: string) =>
  `<button class="window-resize" data-resize="${id}" aria-label="调整窗口大小" title="拖动或使用方向键调整大小"></button>`
export function shell() {
  const dock = (id: string, name: string, mark: IconName) =>
    `<button data-dock="${id}" title="${name}">${icon(mark, 19)}<span>${name}</span></button>`
  return `<header class="deskbar"><div class="brand"><img src="/fabric.svg" width="28" height="28" alt=""><span>Fabric<span class="brand-light"> Atlas</span></span></div>
    <a class="project-switch" href="/projects/floorplan/" aria-label="切换到 FPGA Floorplan 电路视图">FPGA Floorplan</a>
    <span class="mast-divider"></span><h1>FPGA 结构工作台</h1><div class="family-control"><span class="field-label">器件架构</span><div class="seg" id="families"></div></div></header>
  <main class="desktop-shell" id="desktop" data-mobile="scene">
    <section id="viewport" class="card viewer" aria-label="三维结构窗口">
      <div class="window-head"><h2>${icon('cube', 17)}三维结构</h2><div class="view-tools">
        ${iconButton('zoom-out', '缩小视图', 'minus')}${iconButton('zoom-in', '放大视图', 'plus')}<span class="tool-rule"></span>
        ${iconButton('home', '重置视角', 'fit')}${iconButton('expand', '展开视窗', 'expand')}</div></div>
      <div class="stage-wrap"><div id="stage"></div><nav class="crumbs" id="crumbs" aria-label="当前位置"></nav><div id="parent-map" class="parent-map"></div>
        <div class="axis" aria-hidden="true"><svg viewBox="0 0 59 50"><g fill="none" stroke-width="1.5"><path stroke="#a3ce80"/><path stroke="#d6a477"/><path stroke="#86b2d6"/></g><g font-size="8" font-family="monospace"><text fill="#b0d591">Y</text><text fill="#dfa97c">X</text><text fill="#8ab8dd">Z</text></g></svg></div>
        <span class="gesture">${icon('mouse', 14)}拖动旋转 · 滚轮缩放</span></div>
      <div id="legend" class="legend"></div>
      <section class="wire-drawer" id="wire-drawer" aria-label="线路说明"><div class="wire-head"><h3>${icon('pulse', 16)}线路说明</h3><span id="net-count"></span>
        <button data-dock="wires" title="收起线路说明" aria-label="收起线路说明">${icon('minus', 14)}</button></div>
        <div id="wire-controls"></div><div id="wire-detail"></div></section>
    </section>
    <div id="desktop-split" class="desk-split" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整三维区与模块桌面宽度"></div>
    <div id="module-desk" class="module-desk">
      <section class="card desk-window inspector" id="tree-window" data-panel="tree" aria-label="结构导航窗口">${titleBar('tree', '结构导航', 'tree')}
        <div class="window-body tree-body"><div class="tree-tools"><span id="tree-summary"></span><button id="fold-tree" title="折叠全部分支">收起全部</button></div>
        <div id="tree" class="resource-tree" role="tree" aria-label="完整模块树"></div><div id="insight"></div></div>${resizeHandle('tree')}</section>
      <section class="card desk-window sim-card" id="sim-window" data-panel="sim" aria-label="电路演示窗口">${titleBar('sim', '电路演示', 'pulse')}
        <div class="window-body sim-body"><div id="demos" class="demo-tabs" aria-label="选择电路"></div>
        <div class="clock-panel" id="clock-panel"></div><div class="simulation"><div id="inputs" class="sim-input"></div><div id="readout" class="sim-read"></div><div id="evidence" class="sim-evidence"></div></div></div>
        <div class="transport"><div class="transport-actions"><button data-action="play" class="primary" id="play"></button><button data-action="step" class="secondary">${icon('next', 15)}单步</button>
        ${iconButton('restart', '重播当前示例', 'restart')}<label class="speed"><select id="speed" aria-label="播放速度"><option value=".5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select>${icon('down', 12)}</label></div><div id="timeline" class="timeline"></div></div>${resizeHandle('sim')}</section>
    </div>
    <aside class="desktop-rail" aria-label="程序坞"><div class="dock-main"><span class="dock-caption">工作区</span>${dock('scene', '三维结构', 'cube')}${dock('tree', '结构导航', 'tree')}${dock('sim', '电路演示', 'pulse')}${dock('wires', '线路说明', 'gate')}</div>
      <div class="dock-utils"><button data-action="docs" title="架构手册">${icon('book', 18)}<span>手册</span></button><button data-dock="reset" title="恢复默认桌面布局">${icon('restart', 18)}<span>复位布局</span></button></div></aside>
  </main>
  <dialog id="docs"><div class="dialog-top"><h2>架构手册</h2>${iconButton('close-docs', '关闭手册', 'close')}</div><p>逻辑块与 Slice 的资源数量取自器件手册。三维位置为架构示意，等效门展示逻辑功能，时钟频率为教学仿真的虚拟频率。</p>
    <a href="https://docs.amd.com/r/en-US/ug474_7Series_CLB/CLB-Overview" target="_blank" rel="noreferrer"><strong>AMD 7 系列</strong><span>UG474 · CLB、Slice 与 LUT6</span>${icon('link', 16)}</a>
    <a href="https://docs.amd.com/r/en-US/ug474_7Series_CLB/Carry-Logic" target="_blank" rel="noreferrer"><strong>AMD 进位逻辑</strong><span>UG474 · CARRY4 与进位通路</span>${icon('link', 16)}</a>
    <a href="https://www.latticesemi.com/view_document?document_id=50461" target="_blank" rel="noreferrer"><strong>Lattice ECP5</strong><span>FPGA-DS-02012 §2.2 · PFU、Slice 与 CCU2</span>${icon('link', 16)}</a></dialog>`
}
