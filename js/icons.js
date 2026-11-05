// Small, original SVG line drawings. No icon font or external request.
const paths = {
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10M3 15h18"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  shield: '<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13 2.6L20 12M4 12l.9 3.3a8 8 0 0 0 13 2.6"/>',
  moon: '<path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  save: '<path d="M5 3h12l4 4v14H3V3h2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8M14 5v2"/>',
  folder: '<path d="M3 7V4h7l2 3h9v13H3V7Z"/><path d="M3 9h18"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>',
  'chevron-down': '<path d="m5 9 7 7 7-7"/>',
  'chevron-up': '<path d="m5 15 7-7 7 7"/>',
  'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
  'arrow-up': '<path d="M12 20V4M5 11l7-7 7 7"/>',
  'arrow-down': '<path d="M12 4v16m-7-7 7 7 7-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  undo: '<path d="M9 5 4 10l5 5M4 10h10a6 6 0 1 1 0 12"/>',
  redo: '<path d="m15 5 5 5-5 5m5-5H10a6 6 0 1 0 0 12"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  code: '<path d="m7 6-5 6 5 6m10-12 5 6-5 6m-4-16-2 20"/>',
  sliders: '<path d="M4 7h7m4 0h5M4 17h3m4 0h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  filter: '<path d="M3 4h18l-7 9v7l-4-2v-5L3 4Z"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-16v16"/>',
  group: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="9" width="6" height="6" rx="1"/><path d="M9 6h3v12H9m3-6h3"/>',
  sort: '<path d="M6 4v16m-3-3 3 3 3-3M12 5h9m-9 5h7m-7 5h5m-5 5h3"/>',
  reshape: '<path d="M3 3h6v6H3zm12 12h6v6h-6zM13 4h7v7m-4-7 4 4M4 13v7h7m-7-4 4 4"/>',
  join: '<circle cx="8" cy="12" r="6"/><circle cx="16" cy="12" r="6"/>',
  window: '<path d="M3 17 7 9l5 5 5-10 4 6M3 21h18"/>',
  missing: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  text: '<path d="M3 5h12m-6 0v15M5 20h8m3-8h5m-2.5 0v8"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  grip: '<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/>',
};
export const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.table}</svg>`;
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]:not([data-icon-ready])').forEach((element) => {
    element.innerHTML = icon(element.dataset.icon);
    element.dataset.iconReady = 'true';
  });
}
export const categoryIcon = (category = '') => ({
  Rows: 'filter', Columns: 'columns', 'Group & summarize': 'group', 'Sort & index': 'sort',
  Reshape: 'reshape', 'Join & combine': 'join', 'Window & rank': 'window',
  'Missing values': 'missing', 'Text & dates': 'text', Advanced: 'code',
}[category] || 'table');
