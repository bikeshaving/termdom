import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

document.head.innerHTML = `
  <style>
    p { color: gray; }
    .warm { color: yellow; }
    .warm.hot { color: red; font-weight: bold; }
    a { color: cyan; text-decoration: underline; }
    del { color: #888; text-decoration: line-through; }
    .badge { background-color: blue; color: white; padding: 0 1ch; }
  </style>
`;

document.body.innerHTML = `
  <p>A paragraph made gray by a CSS rule.</p>
  <p class="warm">A class makes the next paragraph yellow.</p>
  <p class="warm hot">Two classes beat one: red and bold.</p>
  <p class="warm hot" style="color: green">An inline style beats all the rules.</p>
  <p>Text can be <b>bold</b>, <i>italic</i>, <a>underlined</a> or <del>struck through</del>.</p>
  <p><span class="badge">A background</span> paints its cells.</p>
`;
