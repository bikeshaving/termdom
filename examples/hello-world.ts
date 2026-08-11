import {TermDOM} from "@b9g/termdom";

// Create a TermDOM instance and attach it to the terminal.
const term = new TermDOM();
term.attach();
const {document} = term;

// Create standard HTML elements with CSS styling!
const container = document.createElement("div");
container.style.setProperty("background-color", "blue");
container.style.setProperty("color", "white");
container.textContent = "🎯 Hello, HTML Terminal!";

const subtitle = document.createElement("div");
subtitle.style.setProperty("color", "yellow");
subtitle.style.setProperty("margin-top", "1px");
subtitle.textContent = "Standard HTML/CSS → ANSI Terminal Output";

// Add to document (just like web development!)
document.body.appendChild(container);
document.body.appendChild(subtitle);
