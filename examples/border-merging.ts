/**
 * Border Merging Demonstration - Using margin nudges for true intersections
 */

import {TermDOM} from "../src/index.js";

function borderMerging() {
	const dom = new TermDOM();
	const {document} = dom;

	// Main container
	const container = document.createElement("div");
	container.style.padding = "2px";
	container.style.backgroundColor = "#001122";
	document.body.appendChild(container);

	// Example 1: Force exact overlap with absolute positioning
	const example1 = document.createElement("div");
	example1.style.position = "relative";
	example1.style.height = "6px";
	example1.style.marginBottom = "3px";
	container.appendChild(example1);

	const label1 = document.createElement("div");
	label1.style.color = "cyan";
	label1.style.marginBottom = "1px";
	label1.textContent = "Horizontal Merge (double wins over solid):";
	example1.appendChild(label1);

	const left = document.createElement("div");
	left.style.position = "absolute";
	left.style.border = "1px solid";
	left.style.backgroundColor = "#2a1a1a";
	left.style.color = "white";
	left.style.padding = "1px";
	left.style.width = "12px";
	left.style.height = "2px";
	left.style.top = "1px";
	left.style.left = "2px";
	left.textContent = "Solid";
	example1.appendChild(left);

	const right = document.createElement("div");
	right.style.position = "absolute";
	right.style.border = "1px double";
	right.style.backgroundColor = "#1a2a1a";
	right.style.color = "lightgreen";
	right.style.padding = "1px";
	right.style.width = "12px";
	right.style.height = "2px";
	right.style.top = "1px";
	right.style.left = "13px"; // Overlap at border (left=2+12-1=13, should share cell at x=14)
	right.textContent = "Double";
	example1.appendChild(right);

	// Example 2: T-Junction with multiple overlaps
	const example2 = document.createElement("div");
	example2.style.marginBottom = "3px";
	container.appendChild(example2);

	const label2 = document.createElement("div");
	label2.style.color = "cyan";
	label2.style.marginBottom = "1px";
	label2.textContent = "T-Junction (groove stem wins at intersection):";
	example2.appendChild(label2);

	// Horizontal bar
	const tJunction = document.createElement("div");
	example2.appendChild(tJunction);

	const tHorizontal = document.createElement("div");
	tHorizontal.style.display = "flex";
	tJunction.appendChild(tHorizontal);

	const tLeft = document.createElement("div");
	tLeft.style.border = "1px solid";
	tLeft.style.backgroundColor = "#3a1a1a";
	tLeft.style.color = "lightcoral";
	tLeft.style.padding = "1px";
	tLeft.style.width = "12px";
	tLeft.textContent = "Solid";
	tHorizontal.appendChild(tLeft);

	const tRight = document.createElement("div");
	tRight.style.border = "1px dashed";
	tRight.style.backgroundColor = "#1a1a3a";
	tRight.style.color = "plum";
	tRight.style.padding = "1px";
	tRight.style.width = "12px";
	tRight.style.marginLeft = "-1px";
	tRight.textContent = "Dashed";
	tHorizontal.appendChild(tRight);

	// Vertical stem overlapping both
	const tStem = document.createElement("div");
	tStem.style.border = "1px groove";
	tStem.style.backgroundColor = "#2a2a1a";
	tStem.style.color = "yellow";
	tStem.style.padding = "1px";
	tStem.style.width = "8px";
	tStem.style.height = "4px";
	tStem.style.marginTop = "-1px";
	tStem.style.marginLeft = "8px"; // Center over the junction
	tStem.textContent = "Groove";
	tJunction.appendChild(tStem);

	// Example 3: Full cross intersection
	const example3 = document.createElement("div");
	container.appendChild(example3);

	const label3 = document.createElement("div");
	label3.style.color = "cyan";
	label3.style.marginBottom = "1px";
	label3.textContent = "Cross Intersection (all four directions):";
	example3.appendChild(label3);

	const crossContainer = document.createElement("div");
	crossContainer.style.position = "relative";
	crossContainer.style.height = "8px";
	example3.appendChild(crossContainer);

	// Center element
	const center = document.createElement("div");
	center.style.position = "absolute";
	center.style.border = "1px double";
	center.style.backgroundColor = "#2a2a2a";
	center.style.color = "white";
	center.style.width = "6px";
	center.style.height = "2px";
	center.style.top = "3px";
	center.style.left = "15px";
	center.textContent = "Cross";
	crossContainer.appendChild(center);

	// Top arm
	const top = document.createElement("div");
	top.style.position = "absolute";
	top.style.border = "1px solid";
	top.style.backgroundColor = "#3a1a1a";
	top.style.color = "lightcoral";
	top.style.width = "2px";
	top.style.height = "4px";
	top.style.top = "0px";
	top.style.left = "17px"; // Center of cross
	top.textContent = "T";
	crossContainer.appendChild(top);

	// Bottom arm
	const bottom = document.createElement("div");
	bottom.style.position = "absolute";
	bottom.style.border = "1px dashed";
	bottom.style.backgroundColor = "#1a1a3a";
	bottom.style.color = "plum";
	bottom.style.width = "2px";
	bottom.style.height = "3px";
	bottom.style.top = "4px";
	bottom.style.left = "17px";
	bottom.textContent = "B";
	crossContainer.appendChild(bottom);

	// Left arm
	const leftArm = document.createElement("div");
	leftArm.style.position = "absolute";
	leftArm.style.border = "1px dotted";
	leftArm.style.backgroundColor = "#1a3a1a";
	leftArm.style.color = "lightgreen";
	leftArm.style.width = "6px";
	leftArm.style.height = "2px";
	leftArm.style.top = "3px";
	leftArm.style.left = "10px";
	leftArm.textContent = "Left";
	crossContainer.appendChild(leftArm);

	// Right arm
	const rightArm = document.createElement("div");
	rightArm.style.position = "absolute";
	rightArm.style.border = "1px groove";
	rightArm.style.backgroundColor = "#3a3a1a";
	rightArm.style.color = "orange";
	rightArm.style.width = "6px";
	rightArm.style.height = "2px";
	rightArm.style.top = "3px";
	rightArm.style.left = "20px";
	rightArm.textContent = "Right";
	crossContainer.appendChild(rightArm);
}

borderMerging();
