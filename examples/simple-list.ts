import {TermDOM} from "../src/termdom.js";

const termDOM = new TermDOM();
const {document} = termDOM;

const ul = document.createElement("ul");
const li1 = document.createElement("li");
li1.textContent = "Item 1";
const li2 = document.createElement("li");
li2.textContent = "Item 2";
ul.appendChild(li1);
ul.appendChild(li2);
document.body.appendChild(ul);

//await termDOM.render();
