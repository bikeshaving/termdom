import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();

term.attach();
const {document} = term;

const style = document.createElement("style");
function edge(kind: string) {
	return `border: 1px ${kind};`;
}
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
