const paths = {
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  layers: '<path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  book: '<path d="M3 4h6c1.5 0 2.3.6 3 1.5C12.7 4.6 13.5 4 15 4h6v15h-6c-1.6 0-2.4.5-3 1.4-.6-.9-1.4-1.4-3-1.4H3zM12 6v14"/>',
  cube: '<path d="m3.8 7.1 8.2-4.6 8.2 4.6v9.8L12 21.5l-8.2-4.6zM4 7.2l8 4.6 8-4.6M12 12v9"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><rect x="14" y="14" width="7" height="7" rx="1.2"/>',
  slice: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h5m-5 4h5m-5 4h5m4-8v8"/>',
  gate: '<path d="M6 6h5a6 6 0 0 1 0 12H6zM2 9h4m-4 6h4m11-3h5"/>',
  pulse: '<path d="M2 14h5V6h5v12h5v-7h5"/>',
  tree: '<rect x="3" y="3" width="6" height="6" rx="1.2"/><path d="M6 9v10h7m-7-6h7"/><rect x="13" y="10" width="7" height="5" rx="1"/><rect x="13" y="17" width="7" height="5" rx="1"/>',
  expand: '<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/>',
  fit: '<path d="M3 8V4h4m10 0h4v4M3 16v4h4m10 0h4v-4"/><path d="m8 10 4-2 4 2v5l-4 2-4-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  play: '<path fill="currentColor" stroke="none" d="M6 4.7a.9.9 0 0 1 1.4-.75l12 7.3a.9.9 0 0 1 0 1.5l-12 7.3A.9.9 0 0 1 6 19.3z"/>',
  pause: '<path fill="currentColor" stroke="none" d="M6 4h4v16H6zm8 0h4v16h-4z"/>',
  next: '<path d="m5 5 10 7-10 7zM19 5v14"/>',
  restart: '<path d="M3 5v6h6M3.7 10a8 8 0 1 1 .9 6"/>',
  hand: '<path d="M6 13V9a1.4 1.4 0 0 1 2.8 0V6a1.4 1.4 0 0 1 2.8 0v2-3a1.4 1.4 0 0 1 2.8 0v4-2a1.4 1.4 0 0 1 2.8 0v5l1-1a1.5 1.5 0 0 1 2.2 2l-4.5 6a5 5 0 0 1-7 .8L4.8 15A1.5 1.5 0 0 1 7 13"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>',
  link: '<path d="M13 5h6v6m-1-5-8 8m0-7H5v12h12v-5"/>',
  inspect: '<circle cx="10.5" cy="10.5" r="6.2"/><path d="m15 15 5 5m-13-9h6m-3-3v6"/>',
  compare: '<path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/>',
  mouse: '<rect x="6" y="2.5" width="12" height="19" rx="6"/><path d="M12 6v3"/>',
  osc: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M4 13h4l2-5 3 8 2-5h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>'
} as const
export type IconName = keyof typeof paths
export function icon(name: IconName, size = 18) {
  return (
    '<svg aria-hidden="true" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' +
    paths[name] +
    '</svg>'
  )
}
export const iconButton = (action: string, title: string, name: IconName) =>
  '<button type="button" class="icon-btn" data-action="' +
  action +
  '" title="' +
  title +
  '" aria-label="' +
  title +
  '">' +
  icon(name, 17) +
  '</button>'
