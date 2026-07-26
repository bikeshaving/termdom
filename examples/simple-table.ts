#!/usr/bin/env bun
import {TermDOM} from "../src/internal/termdom.js";

const termdom = new TermDOM();
const {document} = termdom;

// Test different approaches to tables

// Approach 1: Manual grid using divs with flexbox
const title1 = document.createElement("div");
title1.textContent = "Manual Grid (Flexbox):";
title1.style.marginBottom = "1ch";
title1.style.fontWeight = "bold";
document.body.appendChild(title1);

const grid = document.createElement("div");
grid.style.display = "flex";
grid.style.flexDirection = "column";
grid.style.border = "1px solid white";
grid.style.marginBottom = "2ch";

// Header row
const headerRow = document.createElement("div");
headerRow.style.display = "flex";
headerRow.style.borderBottom = "1px solid white";
["Name", "Status", "Score"].forEach((text, i) => {
	const cell = document.createElement("div");
	cell.style.flex = "1";
	cell.style.padding = "0 1ch";
	cell.style.fontWeight = "bold";
	if (i < 2) cell.style.borderRight = "1px solid white";
	cell.textContent = text;
	headerRow.appendChild(cell);
});
grid.appendChild(headerRow);

// Data rows
[
	["Alice", "Active", "95"],
	["Bob", "Pending", "88"],
	["Charlie", "Inactive", "92"],
].forEach((rowData) => {
	const dataRow = document.createElement("div");
	dataRow.style.display = "flex";
	rowData.forEach((text, i) => {
		const cell = document.createElement("div");
		cell.style.flex = "1";
		cell.style.padding = "0 1ch";
		if (i < 2) cell.style.borderRight = "1px solid white";
		cell.textContent = text;
		dataRow.appendChild(cell);
	});
	grid.appendChild(dataRow);
});

document.body.appendChild(grid);

// Approach 2: Test HTML table elements
const title2 = document.createElement("div");
title2.textContent = "HTML Table Elements:";
title2.style.marginBottom = "1ch";
title2.style.fontWeight = "bold";
document.body.appendChild(title2);

const table = document.createElement("table");
table.style.borderCollapse = "collapse";

const thead = document.createElement("thead");
const headerTr = document.createElement("tr");
["ID", "Name", "Email"].forEach((text) => {
	const th = document.createElement("th");
	th.style.border = "1px solid white";
	th.style.padding = "0 1ch";
	th.textContent = text;
	headerTr.appendChild(th);
});
thead.appendChild(headerTr);
table.appendChild(thead);

const tbody = document.createElement("tbody");
[
	["1", "John", "john@test.com"],
	["2", "Jane", "jane@test.com"],
].forEach((rowData) => {
	const tr = document.createElement("tr");
	rowData.forEach((cellData) => {
		const td = document.createElement("td");
		td.style.border = "1px solid white";
		td.style.padding = "0 1ch";
		td.textContent = cellData;
		tr.appendChild(td);
	});
	tbody.appendChild(tr);
});
table.appendChild(tbody);

document.body.appendChild(table);

await termdom.render();
