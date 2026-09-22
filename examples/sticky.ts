// Sticky: section headings that hold the top of the scroller
//
//   node examples/sticky.ts
//
//   Scroll with j/k, the arrow keys or the wheel. Each section's heading
//   is position: sticky; it scrolls up with its section until it reaches
//   the top, holds there while the section's rows pass under it, and is
//   pushed out by the next heading. The footer is sticky at the bottom
//   the same way.
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

const SECTIONS: Record<string, string> = {
  Fruit: "apple banana cherry date elderberry fig grape",
  Vegetables: "artichoke beet carrot daikon endive fennel",
  Grains: "amaranth barley corn durum einkorn farro",
  Herbs: "anise basil chervil dill epazote fenugreek",
  Spices: "allspice cardamom chili elderflower fenugreek ginger",
};

document.head.innerHTML = `
  <style>
    .list { height: 100%; overflow-y: auto; }
    h1 { color: cyan; padding: 0 1ch; }
    section { padding-bottom: 1px; }
    h2 {
      position: sticky;
      top: 0;
      background-color: #264653;
      color: white;
      font-weight: bold;
      padding: 0 1ch;
    }
    li { padding-left: 2ch; }
    .footer {
      position: sticky;
      bottom: 0;
      background-color: #333333;
      color: #aaaaaa;
      padding: 0 1ch;
    }
  </style>
`;

document.body.innerHTML = `
  <div class="list">
    <h1>Pantry</h1>
    ${Object.entries(SECTIONS).map(([name, items]) => `
      <section>
        <h2>${name}</h2>
        <ul>${items.split(" ").map((item) => `<li>${item}</li>`).join("")}</ul>
      </section>
    `).join("")}
    <div class="footer">j/k scroll · q quit</div>
  </div>
`;

const list = document.querySelector(".list") as HTMLElement;
void list.requestFullscreen();

const STEPS: Record<string, number> = {
  j: 1,
  ArrowDown: 1,
  k: -1,
  ArrowUp: -1,
  " ": 10,
  PageDown: 10,
  PageUp: -10,
};

document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "q" || (event.key === "c" && event.ctrlKey)) {
    term.window.close();
  } else if (event.key in STEPS) {
    list.scrollBy(0, STEPS[event.key]);
  }
});
