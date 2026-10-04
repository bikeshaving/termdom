import {readFile} from "node:fs/promises";

import {TermDOM} from "@b9g/termdom";

// node examples/images.ts [path-or-url]
//
// With no argument, the image is a picture drawn on a canvas and handed
// to <img> as a data: URL, so the example runs anywhere.
const source = typeof process === "undefined" ? undefined : process.argv[2];

// Images load only through the fetch a TermDOM is given. This one reads
// a file: URL from disk, which Node's own fetch does not, and leaves the
// rest to the runtime.
const term = new TermDOM({
  async fetch(request) {
    if (request.url.startsWith("file:")) {
      return new Response(await readFile(new URL(request.url)));
    }
    return fetch(request);
  },
});
term.attach();
const {document} = term;

function drawPicture(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);
  const sky = ctx.createLinearGradient(0, 0, 0, 120);
  sky.addColorStop(0, "#0b1d51");
  sky.addColorStop(0.6, "#c0477a");
  sky.addColorStop(1, "#ffb86b");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 160, 120);
  const sun = ctx.createRadialGradient(80, 78, 4, 80, 78, 34);
  sun.addColorStop(0, "#fff6c9");
  sun.addColorStop(1, "rgba(255, 210, 127, 0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, 160, 120);
  ctx.fillStyle = "#1b1b3a";
  ctx.beginPath();
  ctx.moveTo(0, 120);
  ctx.lineTo(0, 92);
  ctx.lineTo(40, 70);
  ctx.lineTo(70, 88);
  ctx.lineTo(110, 60);
  ctx.lineTo(160, 90);
  ctx.lineTo(160, 120);
  ctx.closePath();
  ctx.fill();
  return canvas.toDataURL();
}

const src = source ?? drawPicture();

document.body.innerHTML = `
  <style>
    .app { padding: 1 2ch; }
    h2 { color: #5fafff; font-weight: bold; }
    .row { display: flex; gap: 2ch; }
    .label { color: #888; }
    .box { width: 24ch; height: 8px; background-color: #303030; }
    .natural img { max-width: 60ch; }
  </style>
  <div class="app">
    <h2>&lt;img&gt;</h2>
    <div class="natural"><img id="hero" alt="(the image could not be read)"></div>
    <div class="row">
      <div>
        <div class="label">object-fit: fill</div>
        <img class="box" style="object-fit: fill">
      </div>
      <div>
        <div class="label">object-fit: contain</div>
        <img class="box" style="object-fit: contain">
      </div>
      <div>
        <div class="label">object-fit: cover</div>
        <img class="box" style="object-fit: cover">
      </div>
    </div>
    <p>A broken image is a box with its alt text: <img src="missing.png" alt="no cover art"></p>
  </div>
`;

for (const image of document.querySelectorAll("img:not([src])")) {
  (image as HTMLImageElement).src = src;
}
