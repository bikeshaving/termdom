/**
 * Border Showcase - demonstrating comprehensive border support
 */

import {TermDOM} from "../src/index.js";

function borderShowcase() {
	const dom = new TermDOM();
	const {document} = dom;

	// Create main container
	const container = document.createElement("div");
	container.style.display = "flex";
	container.style.flexDirection = "column";
	container.style.gap = "2px";
	container.style.padding = "2px";
	container.style.backgroundColor = "#001122";
	document.body.appendChild(container);

	// Title
	const title = document.createElement("div");
	title.style.color = "cyan";
	title.style.textAlign = "center";
	title.style.marginBottom = "1px";
	title.textContent = "Border Intersection Test";
	container.appendChild(title);

	// T-Junction Test - Top T (┬) with negative margins for overlap
	const topTContainer = document.createElement("div");
	topTContainer.style.display = "flex";
	topTContainer.style.flexDirection = "column";
	topTContainer.style.gap = "0px";
	container.appendChild(topTContainer);

	const topTHorizontal = document.createElement("div");
	topTHorizontal.style.display = "flex";
	topTHorizontal.style.flexDirection = "row";
	topTHorizontal.style.gap = "0px";
	topTContainer.appendChild(topTHorizontal);

	// Three boxes side by side
	const topLeft = document.createElement("div");
	topLeft.style.border = "1px solid";
	topLeft.style.backgroundColor = "#2a1a1a";
	topLeft.style.color = "white";
	topLeft.style.padding = "1px";
	topLeft.style.flexBasis = "33%";
	topLeft.style.minHeight = "2px";
	topLeft.textContent = "Solid";
	topTHorizontal.appendChild(topLeft);

	const topCenter = document.createElement("div");
	topCenter.style.border = "1px double";
	topCenter.style.backgroundColor = "#1a2a1a";
	topCenter.style.color = "lightgreen";
	topCenter.style.padding = "1px";
	topCenter.style.flexBasis = "33%";
	topCenter.style.minHeight = "2px";
	topCenter.style.marginLeft = "-1px"; // Overlap with left element
	topCenter.textContent = "Double";
	topTHorizontal.appendChild(topCenter);

	const topRight = document.createElement("div");
	topRight.style.border = "1px dashed";
	topRight.style.backgroundColor = "#1a1a2a";
	topRight.style.color = "lightblue";
	topRight.style.padding = "1px";
	topRight.style.flexBasis = "33%";
	topRight.style.minHeight = "2px";
	topRight.style.marginLeft = "-1px"; // Overlap with center element
	topRight.textContent = "Dashed";
	topTHorizontal.appendChild(topRight);

	// Bottom connecting element for T-junction with negative margin to overlap
	const bottomT = document.createElement("div");
	bottomT.style.border = "1px dotted";
	bottomT.style.backgroundColor = "#2a2a1a";
	bottomT.style.color = "yellow";
	bottomT.style.padding = "1px";
	bottomT.style.width = "33%";
	bottomT.style.alignSelf = "center";
	bottomT.style.minHeight = "3px";
	bottomT.style.marginTop = "-1px"; // Overlap with top elements to create T-junction
	bottomT.textContent = "Dotted Stem";
	topTContainer.appendChild(bottomT);

	// Cross Intersection Test
	const crossTitle = document.createElement("div");
	crossTitle.style.color = "cyan";
	crossTitle.style.textAlign = "center";
	crossTitle.style.marginTop = "1px";
	crossTitle.textContent = "Cross Intersection (┼)";
	container.appendChild(crossTitle);

	const crossContainer = document.createElement("div");
	crossContainer.style.display = "flex";
	crossContainer.style.flexDirection = "column";
	crossContainer.style.gap = "0px";
	container.appendChild(crossContainer);

	// Top part of cross
	const crossTop = document.createElement("div");
	crossTop.style.border = "1px solid";
	crossTop.style.backgroundColor = "#3a1a1a";
	crossTop.style.color = "lightcoral";
	crossTop.style.padding = "1px";
	crossTop.style.width = "20%";
	crossTop.style.alignSelf = "center";
	crossTop.style.minHeight = "2px";
	crossTop.textContent = "Top";
	crossContainer.appendChild(crossTop);

	// Middle horizontal section with overlaps
	const crossMiddle = document.createElement("div");
	crossMiddle.style.display = "flex";
	crossMiddle.style.flexDirection = "row";
	crossMiddle.style.gap = "0px";
	crossMiddle.style.marginTop = "-1px"; // Overlap with top element
	crossContainer.appendChild(crossMiddle);

	const crossLeft = document.createElement("div");
	crossLeft.style.border = "1px double";
	crossLeft.style.backgroundColor = "#1a3a1a";
	crossLeft.style.color = "lightgreen";
	crossLeft.style.padding = "1px";
	crossLeft.style.flexBasis = "40%";
	crossLeft.style.minHeight = "2px";
	crossLeft.textContent = "Left";
	crossMiddle.appendChild(crossLeft);

	const crossCenter = document.createElement("div");
	crossCenter.style.border = "1px groove";
	crossCenter.style.backgroundColor = "#2a2a2a";
	crossCenter.style.color = "white";
	crossCenter.style.padding = "1px";
	crossCenter.style.flexBasis = "20%";
	crossCenter.style.minHeight = "2px";
	crossCenter.style.marginLeft = "-1px"; // Overlap with left element
	crossCenter.textContent = "Cross";
	crossMiddle.appendChild(crossCenter);

	const crossRight = document.createElement("div");
	crossRight.style.border = "1px dashed";
	crossRight.style.backgroundColor = "#1a1a3a";
	crossRight.style.color = "plum";
	crossRight.style.padding = "1px";
	crossRight.style.flexBasis = "40%";
	crossRight.style.minHeight = "2px";
	crossRight.style.marginLeft = "-1px"; // Overlap with center element
	crossRight.textContent = "Right";
	crossMiddle.appendChild(crossRight);

	// Bottom part of cross with overlap
	const crossBottom = document.createElement("div");
	crossBottom.style.border = "1px dotted";
	crossBottom.style.backgroundColor = "#1a2a2a";
	crossBottom.style.color = "lightcyan";
	crossBottom.style.padding = "1px";
	crossBottom.style.width = "20%";
	crossBottom.style.alignSelf = "center";
	crossBottom.style.minHeight = "2px";
	crossBottom.style.marginTop = "-1px"; // Overlap with middle elements
	crossBottom.textContent = "Bot";
	crossContainer.appendChild(crossBottom);
}

borderShowcase();
