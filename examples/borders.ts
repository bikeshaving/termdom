/**
 * Border Showcase - demonstrating comprehensive border support
 */

import {TermDOM} from "../src/index.js";

function borderShowcase() {
	const dom = new TermDOM();
	const {document} = dom;

	console.log("🎨 TermDOM Border Showcase");
	console.log("==========================");

	// Create main container with flex column layout like flexbox demo
	const container = document.createElement("div");
	container.style.display = "flex";
	container.style.flexDirection = "column";
	container.style.padding = "1px 2px";
	container.style.backgroundColor = "darkblue";
	document.body.appendChild(container);

	// Solid border box
	const box1 = document.createElement("div");
	box1.style.border = "1px solid";
	box1.style.backgroundColor = "#333333";
	box1.style.color = "white";
	box1.style.padding = "1px 2px";
	box1.textContent = "┌─ Solid Border ─┐";
	container.appendChild(box1);

	// Double border box
	const box2 = document.createElement("div");
	box2.style.border = "1px double";
	box2.style.backgroundColor = "#006600";
	box2.style.color = "yellow";
	box2.style.padding = "1px 2px";
	box2.textContent = "╔═ Double Border ═╗";
	container.appendChild(box2);

	// Rounded border box
	const box3 = document.createElement("div");
	box3.style.border = "1px solid";
	box3.style.borderRadius = "5px";
	box3.style.backgroundColor = "#660000";
	box3.style.color = "white";
	box3.style.padding = "1px 2px";
	box3.textContent = "╭─ Rounded Border ─╮";
	container.appendChild(box3);

	// Dashed border box
	const box4 = document.createElement("div");
	box4.style.border = "1px dashed";
	box4.style.backgroundColor = "#330033";
	box4.style.color = "lime";
	box4.style.padding = "1px 2px";
	box4.textContent = "╌─ Dashed Border ─╌";
	container.appendChild(box4);

	// Dotted border box
	const box5 = document.createElement("div");
	box5.style.border = "1px dotted";
	box5.style.backgroundColor = "#003300";
	box5.style.color = "white";
	box5.style.padding = "1px 2px";
	box5.textContent = "┄─ Dotted Border ─┄";
	container.appendChild(box5);
}

borderShowcase();
