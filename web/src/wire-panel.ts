import { explainSignal, netColor, signalValue } from './logic/signals.ts'
import type { GateGraph } from './logic/gates.ts'
import type { Snapshot } from './logic/simulator.ts'
import type { Location } from './scene/types.ts'
export function wirePanel(
  nets: string[],
  solo: string,
  active: string[],
  s: Snapshot,
  loc: Location,
  graph?: GateGraph
) {
  if (!nets.length)
    return { count: '0 条信号', controls: '', detail: '<p>当前模块没有已分配的示例信号。</p>' }
  const target = solo || active.find((x) => nets.includes(x)) || nets[0]
  const chart = explainSignal(target, s, loc, graph)
  const short =
    nets.length <= 8
      ? nets
      : [...new Set([target, ...active.filter((k) => nets.includes(k)), ...nets])].slice(0, 6)
  let buttons =
    '<button class="wire-chip" data-action="wire" data-value="" aria-pressed="' +
    !solo +
    '">全部线路</button>'
  buttons += short
    .map((net) => {
      const d = explainSignal(net, s, loc, graph)
      return (
        '<button class="wire-chip" data-action="wire" data-value="' +
        net +
        '" style="--wire-color:' +
        netColor(net) +
        '" title="' +
        d.from +
        ' → ' +
        d.to +
        '" aria-pressed="' +
        (net === solo) +
        '"><i></i>' +
        d.name +
        '</button>'
      )
    })
    .join('')
  if (nets.length > 8)
    buttons +=
      '<select data-setting="wire" aria-label="选择任意信号线路"><option value="">选择线路（' +
      nets.length +
      '）</option>' +
      nets
        .map(
          (n) =>
            '<option value="' +
            n +
            '" ' +
            (n === solo ? 'selected' : '') +
            '>' +
            explainSignal(n, s, loc, graph).name +
            ' · ' +
            n +
            '</option>'
        )
        .join('') +
      '</select>'
  const detail =
    '<div class="wire-detail-line" style="--wire-color:' +
    netColor(target) +
    '"><i></i><strong>' +
    chart.name +
    '</strong><code>' +
    signalValue(target, s, graph) +
    '</code><span>' +
    chart.from +
    ' → ' +
    chart.to +
    '</span></div><p>' +
    chart.purpose +
    '</p>'
  return {
    count: nets.length + ' 条信号',
    controls: '<div class="wire-choices">' + buttons + '</div>',
    detail
  }
}
