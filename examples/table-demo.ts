#!/usr/bin/env bun

// First test: Simple HTML table without TanStack
import {TermDOM} from "../src/termdom.js";

const termdom = new TermDOM();
const {document} = termdom;

// Simple HTML table
const tableElement = document.createElement("table");
tableElement.style.border = "1px solid white";

// Header
const thead = document.createElement("thead");
const headerRow = document.createElement("tr");
["Name", "Status", "Score"].forEach((text) => {
	const th = document.createElement("th");
	th.style.border = "1px solid white";
	th.style.padding = "0 1ch";
	th.textContent = text;
	headerRow.appendChild(th);
});
thead.appendChild(headerRow);
tableElement.appendChild(thead);

// Body
const tbody = document.createElement("tbody");
[
	["Alice", "Active", "95"],
	["Bob", "Pending", "88"],
	["Charlie", "Inactive", "92"],
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
tableElement.appendChild(tbody);

document.body.appendChild(tableElement);

await termdom.waitForRender();
