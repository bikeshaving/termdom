#!/usr/bin/env bun
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
const {document} = term;
const style = document.createElement("style");
style.textContent = `
ul {
	list-style-position: outside !important;
}
`;
document.body.appendChild(style);

// Create a comprehensive lists demo
const container = document.createElement("div");

// Title
const title = document.createElement("h1");
title.textContent = "📝 Comprehensive Lists Demo";
title.style.color = "cyan";
container.appendChild(title);

// Basic unordered list
const basicSection = document.createElement("section");
const basicTitle = document.createElement("h2");
basicTitle.textContent = "Basic Unordered List";
basicTitle.style.color = "yellow";
basicSection.appendChild(basicTitle);

const basicUl = document.createElement("ul");
["First item", "Second item", "Third item"].forEach((text) => {
	const li = document.createElement("li");
	li.textContent = text;
	basicUl.appendChild(li);
});
basicSection.appendChild(basicUl);
container.appendChild(basicSection);

// Basic ordered list
const orderedSection = document.createElement("section");
const orderedTitle = document.createElement("h2");
orderedTitle.textContent = "Basic Ordered List";
orderedTitle.style.color = "yellow";
orderedSection.appendChild(orderedTitle);

const basicOl = document.createElement("ol");
["First step", "Second step", "Third step"].forEach((text) => {
	const li = document.createElement("li");
	li.textContent = text;
	basicOl.appendChild(li);
});
orderedSection.appendChild(basicOl);
container.appendChild(orderedSection);

// Different list style types
const stylesSection = document.createElement("section");
const stylesTitle = document.createElement("h2");
stylesTitle.textContent = "List Style Types";
stylesTitle.style.color = "yellow";
stylesSection.appendChild(stylesTitle);

// Disc style
const discUl = document.createElement("ul");
discUl.style.listStyleType = "disc";
["Disc item 1", "Disc item 2"].forEach((text) => {
	const li = document.createElement("li");
	li.textContent = text;
	discUl.appendChild(li);
});
stylesSection.appendChild(discUl);

// Circle style
const circleUl = document.createElement("ul");
circleUl.style.listStyleType = "circle";
["Circle item 1", "Circle item 2"].forEach((text) => {
	const li = document.createElement("li");
	li.textContent = text;
	circleUl.appendChild(li);
});
stylesSection.appendChild(circleUl);

// Square style
const squareUl = document.createElement("ul");
squareUl.style.listStyleType = "square";
["Square item 1", "Square item 2"].forEach((text) => {
	const li = document.createElement("li");
	li.textContent = text;
	squareUl.appendChild(li);
});
stylesSection.appendChild(squareUl);

// Decimal style
const decimalOl = document.createElement("ol");
decimalOl.style.listStyleType = "decimal";
["Decimal item 1", "Decimal item 2"].forEach((text) => {
	const li = document.createElement("li");
	li.textContent = text;
	decimalOl.appendChild(li);
});
stylesSection.appendChild(decimalOl);

// Lower alpha style
const alphaOl = document.createElement("ol");
alphaOl.style.listStyleType = "lower-alpha";
["Alpha item 1", "Alpha item 2", "Alpha item 3"].forEach((text) => {
	const li = document.createElement("li");
	li.textContent = text;
	alphaOl.appendChild(li);
});
stylesSection.appendChild(alphaOl);

// Roman style
const romanOl = document.createElement("ol");
romanOl.style.listStyleType = "lower-roman";
["Roman item 1", "Roman item 2", "Roman item 3"].forEach((text) => {
	const li = document.createElement("li");
	li.textContent = text;
	romanOl.appendChild(li);
});
stylesSection.appendChild(romanOl);
container.appendChild(stylesSection);

// NESTED LISTS
const nestedSection = document.createElement("section");
const nestedTitle = document.createElement("h2");
nestedTitle.textContent = "Nested Lists";
nestedTitle.style.color = "yellow";
nestedSection.appendChild(nestedTitle);

// Simple nested example
const nestedUl = document.createElement("ul");

const item1 = document.createElement("li");
item1.textContent = "Main Item 1";
nestedUl.appendChild(item1);

const item2 = document.createElement("li");
item2.textContent = "Main Item 2 with nested list:";

// Nested list inside item2
const subList = document.createElement("ul");
const subItem1 = document.createElement("li");
subItem1.textContent = "Sub Item 1";
const subItem2 = document.createElement("li");
subItem2.textContent = "Sub Item 2";
subList.appendChild(subItem1);
subList.appendChild(subItem2);
item2.appendChild(subList);

nestedUl.appendChild(item2);

const item3 = document.createElement("li");
item3.textContent = "Main Item 3";
nestedUl.appendChild(item3);

nestedSection.appendChild(nestedUl);
container.appendChild(nestedSection);

// Complex nested example
const complexSection = document.createElement("section");
const complexTitle = document.createElement("h2");
complexTitle.textContent = "Complex Nested Structure";
complexTitle.style.color = "yellow";
complexSection.appendChild(complexTitle);

const complexUl = document.createElement("ul");

// Main item with multiple levels
const complexItem = document.createElement("li");
complexItem.textContent = "Development Process";

const level1Ol = document.createElement("ol");

const planItem = document.createElement("li");
planItem.textContent = "Planning";
const planSubUl = document.createElement("ul");
[
	"Requirements gathering",
	"Architecture design",
	"Timeline estimation",
].forEach((text) => {
	const li = document.createElement("li");
	li.textContent = text;
	planSubUl.appendChild(li);
});
planItem.appendChild(planSubUl);
level1Ol.appendChild(planItem);

const devItem = document.createElement("li");
devItem.textContent = "Development";
const devSubUl = document.createElement("ul");
["Frontend implementation", "Backend services", "Database design"].forEach(
	(text) => {
		const li = document.createElement("li");
		li.textContent = text;
		devSubUl.appendChild(li);
	},
);
devItem.appendChild(devSubUl);
level1Ol.appendChild(devItem);

const testItem = document.createElement("li");
testItem.textContent = "Testing & Deployment";
level1Ol.appendChild(testItem);

complexItem.appendChild(level1Ol);
complexUl.appendChild(complexItem);
complexSection.appendChild(complexUl);
container.appendChild(complexSection);

// Mixed ordered/unordered nesting
const mixedSection = document.createElement("section");
const mixedTitle = document.createElement("h2");
mixedTitle.textContent = "Mixed Ordered/Unordered Nesting";
mixedTitle.style.color = "yellow";
mixedSection.appendChild(mixedTitle);

const mixedOl = document.createElement("ol");

const setupItem = document.createElement("li");
setupItem.textContent = "Setup";
const setupUl = document.createElement("ul");
["Install dependencies", "Configure environment", "Initialize project"].forEach(
	(text) => {
		const li = document.createElement("li");
		li.textContent = text;
		setupUl.appendChild(li);
	},
);
setupItem.appendChild(setupUl);
mixedOl.appendChild(setupItem);

const codeItem = document.createElement("li");
codeItem.textContent = "Write Code";
const codeUl = document.createElement("ul");
["Implement features", "Write tests", "Debug issues"].forEach((text) => {
	const li = document.createElement("li");
	li.textContent = text;
	codeUl.appendChild(li);
});
codeItem.appendChild(codeUl);
mixedOl.appendChild(codeItem);

const deployItem = document.createElement("li");
deployItem.textContent = "Deploy";
mixedOl.appendChild(deployItem);

mixedSection.appendChild(mixedOl);
container.appendChild(mixedSection);

document.body.appendChild(container);

await new Promise<void>((r) => term.window.requestAnimationFrame(() => r()));
await new Promise<void>((r) => term.window.requestAnimationFrame(() => r()));

process.exit(0);
