import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

const heading = document.createElement("div");
heading.style.backgroundColor = "blue";
heading.style.color = "white";
heading.style.padding = "0 1ch";
heading.textContent = "Hello, terminal";

const subtitle = document.createElement("div");
subtitle.style.color = "yellow";
subtitle.style.marginTop = "1px";
subtitle.textContent = "HTML and CSS, drawn with ANSI escape sequences";

document.body.appendChild(heading);
document.body.appendChild(subtitle);
