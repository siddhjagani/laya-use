// Vector icons (24×24, 1.8px strokes). Built as SVG nodes, so the strict CSP needs no fonts or external files.
const ICONS = {
  back: [["path", { d: "M15 18l-6-6 6-6" }]],
  forward: [["path", { d: "M9 18l6-6-6-6" }]],
  reload: [["path", { d: "M21 12a9 9 0 1 1-2.64-6.36L21 8" }], ["path", { d: "M21 3v5h-5" }]],
  home: [["path", { d: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" }]],
  star: [["path", { d: "M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6L12 17l-5.38 2.85 1.03-6L3.3 9.6l6-.9z" }]],
  library: [["path", { d: "M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z" }], ["path", { d: "M4 19.5V4.5" }],
            ["path", { d: "M8 7h8" }]],
  settings: [["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }],
             ["circle", { cx: 12, cy: 12, r: 3 }]],
  sparkles: [["path", { d: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" }], ["path", { d: "M19 3v4M17 5h4" }],
             ["path", { d: "M5 17v3M3.5 18.5h3" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  compose: [["path", { d: "M12 20h9" }], ["path", { d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" }]],
  history: [["path", { d: "M3 12a9 9 0 1 0 3-6.7L3 8" }], ["path", { d: "M3 3v5h5" }], ["path", { d: "M12 7v5l3 2" }]],
  close: [["path", { d: "M18 6 6 18M6 6l12 12" }]],
  send: [["path", { d: "M12 19V5M5 12l7-7 7 7" }]],
  stop: [["rect", { x: 7, y: 7, width: 10, height: 10, rx: 2, fill: "currentColor" }]],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  bulb: [["path", { d: "M9 18h6M10 22h4" }], ["path", { d: "M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z" }]],
  shield: [["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }]],
  user: [["circle", { cx: 12, cy: 8, r: 4 }], ["path", { d: "M4 21a8 8 0 0 1 16 0" }]],
  users: [["circle", { cx: 9, cy: 8, r: 3.5 }], ["path", { d: "M2.5 20a6.5 6.5 0 0 1 13 0" }],
          ["path", { d: "M16 4.3a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" }]],
  globe: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" }]],
  lock: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ["path", { d: "M8 11V7a4 4 0 0 1 8 0v4" }]],
  download: [["path", { d: "M12 3v12M7 10l5 5 5-5M5 21h14" }]],
  search: [["circle", { cx: 11, cy: 11, r: 7 }], ["path", { d: "M21 21l-4.3-4.3" }]],
  cpu: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 }], ["rect", { x: 9.5, y: 9.5, width: 5, height: 5, rx: 1 }],
        ["path", { d: "M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" }]],
  palette: [["path", { d: "M12 3a9 9 0 0 0 0 18c1 0 1.6-.8 1.6-1.6 0-.4-.2-.8-.4-1.1a1.6 1.6 0 0 1 1.2-2.7H16a5 5 0 0 0 5-5C21 6.6 17 3 12 3z" }],
            ["circle", { cx: 7.5, cy: 11, r: 1, fill: "currentColor" }], ["circle", { cx: 10.5, cy: 7, r: 1, fill: "currentColor" }],
            ["circle", { cx: 15, cy: 7.5, r: 1, fill: "currentColor" }]],
  power: [["path", { d: "M12 2v9" }], ["path", { d: "M18.4 6.6a9 9 0 1 1-12.8 0" }]],
  languages: [["path", { d: "M4 5h9M8.5 3v2M11 5c-.8 3.5-3.4 6.8-6.5 8.5M6.5 9c1 1.8 2.8 3.4 4.8 4.3" }],
              ["path", { d: "M13 21l4-10 4 10M14.5 17.5h5" }]],
  monitor: [["rect", { x: 2, y: 3, width: 20, height: 14, rx: 2 }], ["path", { d: "M8 21h8M12 17v4" }]],
  sliders: [["path", { d: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5" }]],
  reset: [["path", { d: "M3 12a9 9 0 1 0 2.64-6.36L3 8" }], ["path", { d: "M3 3v5h5" }]],
  info: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 16v-4M12 8h.01" }]],
  trash: [["path", { d: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" }]],
  incognito: [["circle", { cx: 6.5, cy: 16, r: 3 }], ["circle", { cx: 17.5, cy: 16, r: 3 }], ["path", { d: "M9.5 16h5M2 11h20M5 11l2-6h10l2 6" }]],
  panel: [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ["path", { d: "M15 3v18" }]],
  update: [["path", { d: "M12 3v12M7 10l5 5 5-5" }], ["path", { d: "M5 21h14" }]],
  mail: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ["path", { d: "M3 7l9 6 9-6" }]],
  logout: [["path", { d: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l-5-5 5-5M5 12h12" }]],
  folder: [["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }]],
  external: [["path", { d: "M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" }]],
  alert: [["path", { d: "M12 3 2 21h20z" }], ["path", { d: "M12 10v4M12 17.5h.01" }]],
  page: [["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }], ["path", { d: "M14 2v6h6" }]],
  zoom: [["circle", { cx: 11, cy: 11, r: 7 }], ["path", { d: "M21 21l-4.3-4.3M8 11h6M11 8v6" }]],
};

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: `i i-${name}` })) {
    svg.setAttribute(k, v);
  }
  for (const [tag, attrs] of ICONS[name] || ICONS.info) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

// <button data-icon="back"> gets its icon; data-icon-size sets the size. Existing text stays as the label.
function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll("[data-icon]")) {
    if (node.querySelector(":scope > svg.i")) continue;
    node.prepend(icon(node.dataset.icon, Number(node.dataset.iconSize) || 18));
  }
}
window.icon = icon;
window.hydrateIcons = hydrateIcons;
