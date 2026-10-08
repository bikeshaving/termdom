import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();

// Two canvases. "2d" draws pixels, two to a cell; "termdom-cellgrid" draws
// cells directly, one glyph and two colors each.
const {document, window} = term;
document.body.innerHTML = `
  <style>
    .app { padding: 1 2ch; }
    h2 { color: #5fafff; font-weight: bold; }
    .row { display: flex; gap: 3ch; }
    .label { color: #888; }
  </style>
  <div class="app">
    <h2>&lt;canvas&gt;</h2>
    <div class="row">
      <div>
        <div class="label">getContext("2d")</div>
        <canvas id="pixels" width="240" height="192"></canvas>
      </div>
      <div>
        <div class="label">getContext("termdom-cellgrid")</div>
        <canvas id="cells" width="30" height="16"></canvas>
      </div>
    </div>
    <div class="label">Ctrl+C quits</div>
  </div>
`;

// A cell is about twice as tall as it is wide, so the 2d canvas is sized
// in cells with CSS and its pixels stretch to fit.
const pixels = document.getElementById("pixels") as HTMLCanvasElement;
pixels.style.width = "40ch";
pixels.style.height = "16px";
const ctx = pixels.getContext("2d")!;

const grid = (document.getElementById("cells") as HTMLCanvasElement)
  .getContext("termdom-cellgrid" as "2d") as any;

// Conway's Life on the grid, seeded with a glider, blinkers, a toad and
// an R-pentomino, which keeps changing for a long time.
const cols = 30;
const rows = 16;
let life = Array.from({length: rows}, () => new Array(cols).fill(false));
for (const [x, y] of [
  [1, 0],
  [2, 1],
  [0, 2],
  [1, 2],
  [2, 2],
  [12, 5],
  [13, 5],
  [14, 5],
  [20, 2],
  [20, 3],
  [20, 4],
  [24, 8],
  [25, 8],
  [26, 8],
  [23, 9],
  [24, 9],
  [25, 9],
  [9, 11],
  [10, 11],
  [8, 12],
  [9, 12],
  [9, 13],
]) {
  life[y][x] = true;
}

function stepLife(): void {
  life = life.map((row, y) => row.map((alive, x) => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (
          (dx || dy) && life[(y + dy + rows) % rows][(x + dx + cols) % cols]
        ) {
          n++;
        }
      }
    }
    return n === 3 || (alive && n === 2);
  }));
}

let t = 0;

function frame(): void {
  t += 1;
  const {width, height} = pixels;

  // A plasma, written a pixel at a time with putImageData().
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v =
        Math.sin(x / 40 + t / 10) +
        Math.sin(y / 30 - t / 14) +
        Math.sin((x + y) / 60 + t / 8) +
        Math.sin(Math.hypot(x - width / 2, y - height / 2) / 24 - t / 6);
      const at = (y * width + x) * 4;
      image.data[at] = 128 + 127 * Math.sin(v * 0.8);
      image.data[at + 1] = 128 + 127 * Math.sin(v * 0.8 + 2.1);
      image.data[at + 2] = 128 + 127 * Math.sin(v * 0.8 + 4.2);
      image.data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // A square turning about the center, filled and outlined with paths.
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(t / 15);
  ctx.fillStyle = "rgba(16, 16, 32, 0.8)";
  ctx.fillRect(-50, -50, 100, 100);
  ctx.lineWidth = 8;
  ctx.strokeStyle = "#ffffff";
  ctx.strokeRect(-50, -50, 100, 100);
  ctx.restore();

  // Text stays text: it is drawn as cells over the pixels.
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "top";
  ctx.fillText(`frame ${t}`, 8, 4);

  // The grid: a dark field, live cells as blocks, and a status line.
  grid.fillStyle = "#101820";
  grid.fillRect(0, 0, cols, rows);
  grid.fillStyle = "#98c379";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (life[y][x]) {
        grid.fillText("█", x, y);
      }
    }
  }
  grid.fillStyle = "#e5c07b";
  grid.font = "bold";
  grid.textAlign = "right";
  grid.fillText(`gen ${t}`, cols, rows - 1);
  grid.textAlign = "left";
  grid.font = "";
  stepLife();
}

frame();
window.setInterval(frame, 100);
