/**
 * Three images: a PNG this script builds and hands over as a data: URL,
 * one read from a file in the repository, and one whose source does not
 * exist.
 *
 * A terminal that speaks the kitty graphics protocol (kitty, Ghostty,
 * WezTerm) or iTerm2's inline images draws the first two. Everywhere else
 * -- and always for the third -- the box shows its alt text instead, at
 * whatever size it was given.
 */
import {deflateSync} from "node:zlib";

import {TermDOM} from "@b9g/termdom";

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[i] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(body, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

/** A gradient, as an 8-bit truecolor PNG with no interlacing. */
function makeGradient(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;

  // Every scanline opens with a filter byte, then three bytes a pixel.
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const start = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const at = start + 1 + x * 3;
      raw[at] = Math.round((x / (width - 1)) * 255);
      raw[at + 1] = Math.round((y / (height - 1)) * 255);
      raw[at + 2] = 0x80;
    }
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

function toDataURL(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

const term = new TermDOM();

term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
  .app { padding: 1 2ch; }
  h2 { color: cyan; }
  .label { color: #888; padding: 1 0 0 0; }
  .row { display: flex; flex-direction: row; gap: 3ch; align-items: flex-start; }
  .frame { border: 1px solid; color: #666; padding: 0 1ch; }
  .note { color: #888; padding: 1 0 0 0; }
`;
document.head.appendChild(style);

const app = document.createElement("div");
app.className = "app";
app.innerHTML = `
  <h2>Images</h2>
  <div class="label">a data: URL, a file, and a source that is not there</div>
  <div class="row">
    <div class="frame"><img width="16" height="8" alt="[ gradient ]" src="${
  toDataURL(makeGradient(128, 64))
}"></div>
    <div class="frame"><img width="24" height="10" alt="[ solitaire ]" src="docs/solitaire.png"></div>
    <div class="frame"><img width="14" height="4" alt="[ missing ]" src="docs/not-here.png"></div>
  </div>
  <div class="note">Run this from the repository root: the middle image is a path relative to the working directory.</div>
`;
document.body.appendChild(app);
