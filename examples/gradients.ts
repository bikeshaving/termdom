import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();

// A cell is about twice as tall as it is wide, so a bar twice as wide as it
// is tall is square on screen, and its corner gradients reach the corners.
const {document} = term;
document.body.innerHTML = `
  <style>
    .app { padding: 1 2ch; }
    h2 { color: #5fafff; font-weight: bold; }
    .label { color: #888; padding: 1 0 0 0; }
    .bar { height: 3px; width: 48ch; }
    .row { display: flex; flex-direction: row; gap: 2ch; }
    .row .bar { width: 22ch; }

    .to-right { background-image: linear-gradient(to right, #1a4d8f, #9fd0ff); }
    .to-bottom { background-image: linear-gradient(to bottom, #7b2d8e, #f0a45d); }
    .corner {
      background-image: linear-gradient(to bottom right, #0f5132, #b7f7c8);
    }
    .angled { background-image: linear-gradient(45deg, #8f1a1a, #ffd27f); }

    /* An angle in any unit. 0deg points up and grows clockwise, so 90deg
       is "to right" and 0.5turn is "to bottom". */
    .angles .bar { width: 8ch; height: 4px; }
    .deg-0 { background-image: linear-gradient(0deg, #1b263b, #e0e1dd); }
    .deg-30 { background-image: linear-gradient(30deg, #1b263b, #e0e1dd); }
    .deg-60 { background-image: linear-gradient(60deg, #1b263b, #e0e1dd); }
    .deg-90 { background-image: linear-gradient(90deg, #1b263b, #e0e1dd); }
    .deg-120 { background-image: linear-gradient(120deg, #1b263b, #e0e1dd); }
    .turn { background-image: linear-gradient(0.75turn, #1b263b, #e0e1dd); }
    .grad { background-image: linear-gradient(300grad, #1b263b, #e0e1dd); }

    /* Two stops in one place are a hard edge, so a gradient can also be a
       set of bands. */
    .bands {
      background-image: linear-gradient(
        to right,
        #e06c75 0%, #e06c75 25%,
        #e5c07b 25%, #e5c07b 50%,
        #98c379 50%, #98c379 75%,
        #61afef 75%, #61afef 100%
      );
    }

    .stripes {
      background-image: repeating-linear-gradient(
        to right,
        #2c3e50 0, #2c3e50 2ch,
        #34495e 2ch, #34495e 4ch
      );
    }

    /* The flat color shows through wherever the gradient fades out. */
    .fade {
      background-color: #1a1a2e;
      background-image: linear-gradient(to right, transparent, #e94560);
    }

    .caption { color: white; padding: 0 1ch; }
  </style>
  <div class="app">
    <h2>linear-gradient()</h2>

    <div class="label">to right</div>
    <div class="bar to-right"></div>

    <div class="label">to bottom / to bottom right / 45deg</div>
    <div class="row">
      <div class="bar to-bottom"></div>
      <div class="bar corner"></div>
      <div class="bar angled"></div>
    </div>

    <div class="label">0deg / 30deg / 60deg / 90deg / 120deg / 0.75turn / 300grad</div>
    <div class="row angles">
      <div class="bar deg-0"></div>
      <div class="bar deg-30"></div>
      <div class="bar deg-60"></div>
      <div class="bar deg-90"></div>
      <div class="bar deg-120"></div>
      <div class="bar turn"></div>
      <div class="bar grad"></div>
    </div>

    <div class="label">hard stops</div>
    <div class="bar bands"></div>

    <div class="label">repeating-linear-gradient()</div>
    <div class="bar stripes"></div>

    <div class="label">a transparent stop, over background-color</div>
    <div class="bar fade"><div class="caption">text keeps the gradient</div></div>
  </div>
`;
