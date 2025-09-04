#!/usr/bin/env bun
import { TermDOM } from "../src/termdom.js";

const termdom = new TermDOM();
const { document } = termdom;

// Title
const title = document.createElement("h1");
title.textContent = "📝 List Rendering Demo";
title.style.color = "cyan";
title.style.marginBottom = "1ch";
document.body.appendChild(title);

// Unordered List
const ulTitle = document.createElement("h2");
ulTitle.textContent = "Unordered Lists:";
ulTitle.style.color = "yellow";
ulTitle.style.marginBottom = "1ch";
document.body.appendChild(ulTitle);

const ul = document.createElement("ul");
ul.style.marginBottom = "2ch";

["First item", "Second item", "Third item"].forEach(text => {
  const li = document.createElement("li");
  li.textContent = text;
  ul.appendChild(li);
});

document.body.appendChild(ul);

// Ordered List  
const olTitle = document.createElement("h2");
olTitle.textContent = "Ordered Lists:";
olTitle.style.color = "yellow"; 
olTitle.style.marginBottom = "1ch";
document.body.appendChild(olTitle);

const ol = document.createElement("ol");
ol.style.marginBottom = "2ch";

["First step", "Second step", "Third step"].forEach(text => {
  const li = document.createElement("li");
  li.textContent = text;
  ol.appendChild(li);
});

document.body.appendChild(ol);

// Different list style types
const stylesTitle = document.createElement("h2");
stylesTitle.textContent = "List Style Types:";
stylesTitle.style.color = "yellow";
stylesTitle.style.marginBottom = "1ch";
document.body.appendChild(stylesTitle);

// Disc (default)
const discList = document.createElement("ul");
discList.style.listStyleType = "disc";
discList.style.marginBottom = "1ch";
["Disc item 1", "Disc item 2"].forEach(text => {
  const li = document.createElement("li");
  li.textContent = text;
  discList.appendChild(li);
});
document.body.appendChild(discList);

// Circle
const circleList = document.createElement("ul");
circleList.style.listStyleType = "circle";
circleList.style.marginBottom = "1ch";
["Circle item 1", "Circle item 2"].forEach(text => {
  const li = document.createElement("li");
  li.textContent = text;
  circleList.appendChild(li);
});
document.body.appendChild(circleList);

// Square
const squareList = document.createElement("ul");
squareList.style.listStyleType = "square";
squareList.style.marginBottom = "1ch";
["Square item 1", "Square item 2"].forEach(text => {
  const li = document.createElement("li");
  li.textContent = text;
  squareList.appendChild(li);
});
document.body.appendChild(squareList);

// Nested Lists
const nestedTitle = document.createElement("h2");
nestedTitle.textContent = "Nested Lists:";
nestedTitle.style.color = "yellow";
nestedTitle.style.marginBottom = "1ch";
document.body.appendChild(nestedTitle);

const nestedList = document.createElement("ul");
const mainItem = document.createElement("li");
mainItem.textContent = "Main item";
nestedList.appendChild(mainItem);

const subList = document.createElement("ul");
subList.style.listStyleType = "circle";
["Sub item 1", "Sub item 2"].forEach(text => {
  const li = document.createElement("li");
  li.textContent = text;
  subList.appendChild(li);
});
mainItem.appendChild(subList);

const mainItem2 = document.createElement("li");
mainItem2.textContent = "Second main item";
nestedList.appendChild(mainItem2);

document.body.appendChild(nestedList);

await termdom.waitForRender();