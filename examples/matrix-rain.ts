import {TermDOM} from "@b9g/termdom";

// The same rain drawn three ways:
//
//   cellgrid  a canvas with the "termdom-cellgrid" context, one glyph a cell
//   2d        the classic browser version: a "2d" canvas, fillText for the
//             glyphs and a translucent black fillRect over everything to fade
//   dom       a <pre> of one <span> per cell, recolored as the rain falls
//
// Usage: matrix-rain.ts [cellgrid|2d|dom] [fps] [shades] [katakana|ascii|mixed]
//
// With 1 shade the trails are one green, as cmatrix draws them. ascii
// draws letters and digits, which every terminal font has; a terminal
// that finds katakana in a fallback font can draw them far slower. mixed
// draws both. q quits.
const usage =
  "Usage: matrix-rain.ts [cellgrid|2d|dom] [fps] [shades] [katakana|ascii|mixed]";
const mode = process.argv[2] ?? "cellgrid";
const fps = Number(process.argv[3]) || 30;
const LEVELS = 1 + Math.max(1, Number(process.argv[4]) || 15);
const glyphSet = process.argv[5] ?? "katakana";
if (
  !["cellgrid", "2d", "dom"].includes(mode) ||
  !["katakana", "ascii", "mixed"].includes(glyphSet)
) {
  console.error(usage);
  process.exit(1);
}

const term = new TermDOM();
term.attach();
const {document, window} = term;

document.head.innerHTML = `
  <style>
    html, body { margin: 0; background: #000; }
    canvas, pre { display: block; width: 100vw; height: 100vh; margin: 0; }
    pre { overflow: hidden; color: #000; }
  </style>
`;

// Half-width katakana, digits and a few symbols, as in the film.
const KATAKANA = [
  ...Array.from({length: 0xff9d - 0xff66 + 1}, (_, i) =>
    String.fromCharCode(0xff66 + i)),
  ..."0123456789:.=*+-<>¦|",
];
const ASCII = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$+-*=<>:.",
];
const GLYPHS = glyphSet === "ascii"
  ? ASCII
  : glyphSet === "mixed" ? [...KATAKANA, ...ASCII] : KATAKANA;
const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

// Brightness from 0 (gone) to LEVELS - 1 (just behind the head), each
// level a shade of green.
const HEAD = "#e8ffe8";
const SHADES = Array.from({length: LEVELS}, (_, level) => {
  const t = LEVELS === 2 ? 0.8 : level / (LEVELS - 1);
  const g = Math.round(40 + 215 * t);
  const r = Math.round(20 * t * t);
  return `rgb(${r}, ${g}, ${Math.round(30 * t * t)})`;
});

interface Drop {
  y: number;
  speed: number;
  length: number;
}

let cols = 0;
let rows = 0;
let drops: Drop[] = [];
let chars: string[] = [];
let levels = new Uint8Array(0);
let heads = new Uint8Array(0);

function spawn(drop: Drop, above: number): void {
  drop.y = -Math.random() * above;
  drop.speed = 0.3 + Math.random() * 0.7;
  drop.length = 6 + Math.floor(Math.random() * Math.max(6, rows));
}

function resize(newCols: number, newRows: number): void {
  if (newCols === cols && newRows === rows) {
    return;
  }
  cols = newCols;
  rows = newRows;
  drops = Array.from({length: cols}, () => {
    const drop = {y: 0, speed: 0, length: 0};
    spawn(drop, rows * 2);
    return drop;
  });
  chars = Array.from({length: cols * rows}, glyph);
  levels = new Uint8Array(cols * rows);
  heads = new Uint8Array(cols * rows);
}

// Moves every drop and works out each cell's brightness.
function step(): void {
  levels.fill(0);
  heads.fill(0);
  for (let x = 0; x < cols; x++) {
    const drop = drops[x];
    const before = Math.floor(drop.y);
    drop.y += drop.speed;
    const head = Math.floor(drop.y);
    for (let y = Math.max(0, before + 1); y <= Math.min(head, rows - 1); y++) {
      chars[y * cols + x] = glyph();
    }
    if (head - drop.length >= rows) {
      spawn(drop, rows);
      continue;
    }
    for (let age = 0; age < drop.length; age++) {
      const y = head - age;
      if (y < 0) {
        break;
      }
      if (y >= rows) {
        continue;
      }
      const at = y * cols + x;
      levels[at] = Math.max(
        1,
        Math.round((LEVELS - 1) * (1 - age / drop.length)),
      );
      heads[at] = age === 0 ? 1 : 0;
    }
  }
  // Now and then a glyph in a trail changes.
  for (let n = 0; n < cols * rows / 50; n++) {
    const at = Math.floor(Math.random() * cols * rows);
    if (levels[at] > 0) {
      chars[at] = glyph();
    }
  }
}

let draw: () => void;

if (mode === "cellgrid") {
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const grid = canvas.getContext("termdom-cellgrid")!;
  draw = () => {
    resize(grid.cols, grid.rows);
    step();
    grid.clearRect(0, 0, cols, rows);
    for (let at = 0; at < cols * rows; at++) {
      const level = levels[at];
      if (level === 0) {
        continue;
      }
      grid.fillStyle = heads[at] ? HEAD : SHADES[level];
      grid.font = heads[at] ? "bold 1px monospace" : "1px monospace";
      grid.fillText(chars[at], at % cols, Math.floor(at / cols));
    }
  };
} else if (mode === "2d") {
  // The version found all over the web, as it would run in a browser:
  // each frame dims everything drawn so far, then draws one glyph at the
  // bottom of each column. Under the unit cell a pixel is a cell, so the
  // font size is 1.
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const ctx = canvas.getContext("2d")!;
  let fallen: number[] = [];
  draw = () => {
    const width = Math.max(1, Math.round(window.innerWidth));
    const height = Math.max(1, Math.round(window.innerHeight));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      fallen = Array.from({length: width}, () =>
        Math.floor(Math.random() * -height));
    }
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#0f0";
    ctx.font = "1px monospace";
    ctx.textBaseline = "top";
    for (let x = 0; x < fallen.length; x++) {
      ctx.fillText(glyph(), x, fallen[x]);
      if (fallen[x] > height && Math.random() > 0.975) {
        fallen[x] = 0;
      }
      fallen[x]++;
    }
  };
} else {
  const pre = document.createElement("pre");
  document.body.append(pre);
  let spans: HTMLSpanElement[] = [];
  let shown: string[] = [];
  draw = () => {
    const width = Math.max(1, Math.round(window.innerWidth));
    const height = Math.max(1, Math.round(window.innerHeight));
    if (width !== cols || height !== rows) {
      resize(width, height);
      pre.textContent = "";
      spans = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const span = document.createElement("span");
          span.textContent = " ";
          spans.push(span);
          pre.append(span);
        }
        if (y < rows - 1) {
          pre.append("\n");
        }
      }
      shown = new Array(cols * rows).fill("");
    }
    step();
    for (let at = 0; at < cols * rows; at++) {
      const level = levels[at];
      const color = level === 0 ? "" : heads[at] ? HEAD : SHADES[level];
      const text = level === 0 ? " " : chars[at];
      const key = color + text;
      if (shown[at] === key) {
        continue;
      }
      shown[at] = key;
      const span = spans[at];
      span.textContent = text;
      span.style.color = color;
      span.style.fontWeight = heads[at] ? "bold" : "";
    }
  };
}

// Each step waits for the terminal to take the frame before, as cmatrix
// waits on its writes. Steps on a fixed timer would keep the rain falling
// while a slow terminal fell behind, and every frame it did take would
// repaint nearly the whole screen.
let last = 0;

function tick(now: number): void {
  window.requestAnimationFrame(tick);
  if (now - last >= 1000 / fps - 1) {
    last = now;
    draw();
  }
}

window.requestAnimationFrame(tick);

document.addEventListener("keydown", (event) => {
  if ((event as KeyboardEvent).key === "q") {
    window.close();
  }
});
