#!/usr/bin/env bun
import {TermDOM} from "../src/termdom.js";

const termdom = new TermDOM();
const {document} = termdom;

// Test seamless table integration - just HTML, no TanStack imports!
const title = document.createElement("h1");
title.textContent = "🎯 Seamless Table Test (HTML → TanStack → TermDOM)";
title.style.color = "cyan";
title.style.marginBottom = "1ch";
document.body.appendChild(title);

// Standard HTML table - TermDOM should handle TanStack automatically
const table = document.createElement("table");
table.style.border = "1px solid yellow";
table.style.width = "100%";

// Header
const thead = document.createElement("thead");
const headerRow = document.createElement("tr");
["Product", "Price", "Stock", "Rating"].forEach((headerText) => {
	const th = document.createElement("th");
	th.style.border = "1px solid yellow";
	th.style.padding = "0 1ch";
	th.style.backgroundColor = "#333";
	th.textContent = headerText;
	headerRow.appendChild(th);
});
thead.appendChild(headerRow);
table.appendChild(thead);

// Body
const tbody = document.createElement("tbody");
[
	["Laptop", "$999", "12", "4.5★"],
	["Phone", "$599", "8", "4.2★"],
	["Tablet", "$399", "15", "4.7★"],
].forEach((rowData) => {
	const tr = document.createElement("tr");
	rowData.forEach((cellData) => {
		const td = document.createElement("td");
		td.style.border = "1px solid #666";
		td.style.padding = "0 1ch";
		td.textContent = cellData;
		tr.appendChild(td);
	});
	tbody.appendChild(tr);
});
table.appendChild(tbody);

document.body.appendChild(table);

const footer = document.createElement("div");
footer.textContent =
	"✨ This table uses TanStack Table automatically under the hood!";
footer.style.color = "green";
footer.style.marginTop = "1ch";
document.body.appendChild(footer);

await termdom.waitForRender();
