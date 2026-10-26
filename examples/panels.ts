import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();

term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
  .app { padding: 1px 2ch; }
  h2 { color: cyan; }
  .label { color: #888; padding: 1px 0 0 0; }
  .row { display: flex; gap: 2ch; margin-top: 1px; }

  .panel { position: relative; border: 1px solid; padding: 0 1ch; width: 28ch; }
  .panel.round { border-radius: 1px; border-color: plum; }
  .on-top, .on-bottom { position: absolute; padding: 0 1ch; background: Canvas; }
  .on-top { top: -1px; }
  .on-bottom { bottom: -1px; }
  .start { left: 1ch; }
  .end { right: 1ch; }
  .title { color: cyan; font-weight: bold; }
  .count, .hint { color: #888; }
  .badge { color: black; background: lightgreen; }
  .selected { color: black; background: cyan; }

  fieldset { width: 28ch; }
  legend { color: yellow; }
  .key { display: inline-block; width: 6ch; color: #888; }

  .tabs { position: absolute; top: -1px; left: 1ch; display: flex; background: Canvas; }
  .tabs span { padding: 0 1ch; color: #888; }
  .tabs .active { color: black; background: cyan; }

  .divider { position: relative; border-top: 1px dashed #888; margin: 1px 0; width: 58ch; }
  .divider span { position: absolute; top: -1px; left: 0; right: 0; text-align: center; }
  .divider b { padding: 0 1ch; background: Canvas; color: #888; }
`;
document.head.appendChild(style);

const app = document.createElement("div");
app.className = "app";
app.innerHTML = `
  <h2>Labels on borders</h2>
  <div class="label">a positioned label with a background sits on the line</div>
  <div class="row">
    <div class="panel">
      <span class="on-top start title">Files</span>
      <span class="on-top end count">2/14</span>
      <div class="selected">src/index.ts</div>
      <div>src/internal/layout.ts</div>
      <div>README.md</div>
      <span class="on-bottom end hint">enter opens</span>
    </div>
    <div class="panel round">
      <span class="on-top start title">Build</span>
      <span class="on-top end badge">passing</span>
      <div>2,632 tests</div>
      <div>0 failures</div>
      <div>&nbsp;</div>
      <span class="on-bottom start hint">12.4s</span>
    </div>
  </div>
  <div class="label">a fieldset's legend sits on its border with no CSS at all</div>
  <fieldset>
    <legend>Connection</legend>
    <div><span class="key">host</span>example.com</div>
    <div><span class="key">port</span>22</div>
  </fieldset>
  <div class="label">tabs on a border, and a divider with a label</div>
  <div class="row">
    <div class="panel" style="width: 58ch">
      <div class="tabs"><span class="active">Files</span><span>Search</span><span>Git</span></div>
      <div>three tabs drawn over the top edge</div>
    </div>
  </div>
  <div class="divider"><span><b>or</b></span></div>
`;
document.body.appendChild(app);
