/**
 * Border Styles Showcase - All border styles without nesting
 */

import {TermDOM} from "../src/index.js";

function borderStyles() {
	const dom = new TermDOM();
	const {document} = dom;

	console.log("🎨 Border Styles Showcase");
	console.log("=========================");

	// Main container
	const container = document.createElement("div");
	container.style.padding = "2px";
	container.style.backgroundColor = "#001122";
	document.body.appendChild(container);

	// Title
	const title = document.createElement("div");
	title.style.color = "cyan";
	title.style.textAlign = "center";
	title.style.marginBottom = "2px";
	title.textContent = "All Border Styles";
	container.appendChild(title);

	// Border styles to showcase
	const styles = [
		{name: "Solid", border: "1px solid", bg: "#2a1a1a", color: "white"},
		{name: "Double", border: "1px double", bg: "#1a2a1a", color: "lightgreen"},
		{name: "Dashed", border: "1px dashed", bg: "#1a1a2a", color: "lightblue"},
		{name: "Dotted", border: "1px dotted", bg: "#2a2a1a", color: "yellow"},
		{name: "Groove", border: "1px groove", bg: "#2a1a2a", color: "magenta"},
	];

	// Create each border style in its own row
	for (const style of styles) {
		const row = document.createElement("div");
		row.style.display = "flex";
		row.style.alignItems = "center";
		row.style.marginBottom = "1px";
		container.appendChild(row);

		const label = document.createElement("div");
		label.style.color = "white";
		label.style.width = "10px";
		label.textContent = `${style.name}:`;
		row.appendChild(label);

		const box = document.createElement("div");
		box.style.border = style.border;
		box.style.backgroundColor = style.bg;
		box.style.color = style.color;
		box.style.padding = "1px 2px";
		box.style.marginLeft = "2px";
		box.style.width = "20px";
		box.style.textAlign = "center";
		box.textContent = `${style.name} Border`;
		row.appendChild(box);
	}

	// Border radius showcase
	const radiusTitle = document.createElement("div");
	radiusTitle.style.color = "cyan";
	radiusTitle.style.textAlign = "center";
	radiusTitle.style.marginTop = "2px";
	radiusTitle.style.marginBottom = "1px";
	radiusTitle.textContent = "Border Radius";
	container.appendChild(radiusTitle);

	const radiusBox = document.createElement("div");
	radiusBox.style.border = "1px solid";
	radiusBox.style.borderRadius = "2px";
	radiusBox.style.backgroundColor = "#3a2a1a";
	radiusBox.style.color = "orange";
	radiusBox.style.padding = "2px";
	radiusBox.style.width = "25px";
	radiusBox.style.textAlign = "center";
	radiusBox.textContent = "Rounded Corners";
	container.appendChild(radiusBox);

	// Individual border edges
	const edgesTitle = document.createElement("div");
	edgesTitle.style.color = "cyan";
	edgesTitle.style.textAlign = "center";
	edgesTitle.style.marginTop = "2px";
	edgesTitle.style.marginBottom = "1px";
	edgesTitle.textContent = "Individual Edges";
	container.appendChild(edgesTitle);

	const edgesContainer = document.createElement("div");
	edgesContainer.style.display = "flex";
	edgesContainer.style.gap = "2px";
	container.appendChild(edgesContainer);

	const edges = [
		{name: "Top", style: "border-top: 2px solid"},
		{name: "Right", style: "border-right: 2px double"},
		{name: "Bottom", style: "border-bottom: 2px dashed"},
		{name: "Left", style: "border-left: 2px dotted"},
	];

	for (const edge of edges) {
		const edgeBox = document.createElement("div");
		if (edge.style.includes("top")) edgeBox.style.borderTop = "2px solid";
		if (edge.style.includes("right")) edgeBox.style.borderRight = "2px double";
		if (edge.style.includes("bottom"))
			edgeBox.style.borderBottom = "2px dashed";
		if (edge.style.includes("left")) edgeBox.style.borderLeft = "2px dotted";

		edgeBox.style.backgroundColor = "#1a1a1a";
		edgeBox.style.color = "white";
		edgeBox.style.padding = "1px";
		edgeBox.style.textAlign = "center";
		edgeBox.style.flex = "1";
		edgeBox.textContent = edge.name;
		edgesContainer.appendChild(edgeBox);
	}
}

borderStyles();
