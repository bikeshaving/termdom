#!/usr/bin/env bun
// Border showcase: the five charsets, and the cell-union machinery that
// merges overlapping edges into real junction glyphs (├ ┬ ┼ ┤ ┴). Each
// border cell records which directions lines LEAVE it; two boxes sharing a
// cell merge by union and land on the right glyph -- the same machinery
// that collapses table cell borders (see the tanstack-table example for
// border-collapse at work). Overlap here comes from absolutely positioned
// boxes sharing edge cells; no table required.
//
//   bun examples/borders.ts        Ctrl+C to quit

import {TermDOM} from "../src/index.js";

const termdom = new TermDOM();
const {document} = termdom;

const style = document.createElement("style");
const edge = (kind: string) => `border: 1px ${kind};`;
style.textContent = `
  .app { padding: 1 2ch; }
  h2 { color: cyan; }
  .label { color: #888; padding: 1 0 0 0; }
  .gallery { display: flex; flex-direction: row; gap: 2ch; }
  .swatch { padding: 0 1ch; width: 12ch; }
  .solid  { ${edge("solid")}  color: white; }
  .double { ${edge("double")} color: lightgreen; }
  .dashed { ${edge("dashed")} color: lightblue; }
  .dotted { ${edge("dotted")} color: yellow; }
  .groove { ${edge("groove")} color: plum; } /* groove renders the heavy charset */

  /* A 2x2 grid of boxes, each overlapping its neighbors by one cell, so
     every shared edge is ONE line and every meeting point a junction:
     corners, ├ ┬ ┤ ┴ on the sides, ┼ in the middle. */
  .grid { position: relative; height: 5px; width: 23ch; color: white; }
  .grid div { position: absolute; ${edge("solid")} width: 12ch; height: 3px; padding: 0 1ch; }
  .nw { top: 0;   left: 0; }
  .ne { top: 0;   left: 11ch; }
  .sw { top: 2px; left: 0; }
  .se { top: 2px; left: 11ch; }
`;
document.head.appendChild(style);

const app = document.createElement("div");
app.className = "app";
app.innerHTML = `
  <h2>Borders</h2>
  <div class="label">charsets</div>
  <div class="gallery"><div class="swatch solid">solid</div><div class="swatch double">double</div><div class="swatch dashed">dashed</div><div class="swatch dotted">dotted</div><div class="swatch groove">groove</div></div>
  <div class="label">shared edges merge: ├ ┬ ┼ ┤ ┴ from four overlapping boxes</div>
  <div class="grid"><div class="nw">NW</div><div class="ne">NE</div><div class="sw">SW</div><div class="se">SE</div></div>
`;
document.body.appendChild(app);
