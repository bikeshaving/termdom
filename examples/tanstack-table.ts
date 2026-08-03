#!/usr/bin/env bun
// TanStack Table driving a real <table> element. termdom doesn't know
// TanStack exists -- the library targets the DOM, and the DOM is real.
//
//   node examples/tanstack-table.ts
import {TermDOM} from "@b9g/termdom";
import {createTable, getCoreRowModel} from "@tanstack/table-core";

const termdom = new TermDOM();
const {document} = termdom;

// Sample data
const data = [
	{
		id: 1,
		name: "John Doe",
		email: "john@example.com",
		status: "Active",
		score: 95,
	},
	{
		id: 2,
		name: "Jane Smith",
		email: "jane@example.com",
		status: "Inactive",
		score: 88,
	},
	{
		id: 3,
		name: "Bob Wilson",
		email: "bob@example.com",
		status: "Pending",
		score: 92,
	},
	{
		id: 4,
		name: "Alice Brown",
		email: "alice@example.com",
		status: "Active",
		score: 87,
	},
];

// Column definitions
const columns = [
	{id: "name", header: "Name", accessorKey: "name"},
	{id: "email", header: "Email", accessorKey: "email"},
	{id: "status", header: "Status", accessorKey: "status"},
	{id: "score", header: "Score", accessorKey: "score"},
];

// Create TanStack table instance with proper state initialization
const table = createTable({
	data,
	columns,
	getCoreRowModel: getCoreRowModel(),
	renderFallbackValue: null,
	// Initialize all required state properties
	state: {
		columnOrder: [],
		columnPinning: {left: [], right: []},
		columnVisibility: {},
		columnSizing: {},
		grouping: [],
		sorting: [],
		pagination: {
			pageIndex: 0,
			pageSize: 10,
		},
	},
	onStateChange: () => {},
});

// Create flexbox-based table using TanStack data
const container = document.createElement("div");
container.style.border = "1px solid cyan";
container.style.borderRadius = "1ch";
container.style.marginBottom = "1ch";

// Title
const title = document.createElement("div");
title.textContent = "TanStack Table + TermDOM Flexbox Integration";
title.style.fontWeight = "bold";
title.style.marginBottom = "1ch";
title.style.color = "cyan";
document.body.appendChild(title);

// Headers using TanStack API
table.getHeaderGroups().forEach((headerGroup) => {
	const headerRow = document.createElement("div");
	headerRow.style.display = "flex";
	headerRow.style.backgroundColor = "#2a2a2a";
	headerRow.style.borderBottom = "1px solid cyan";

	headerGroup.headers.forEach((header, i) => {
		const headerCell = document.createElement("div");
		headerCell.style.flex = "1";
		headerCell.style.padding = "0 1ch";
		headerCell.style.fontWeight = "bold";
		headerCell.style.color = "cyan";
		if (i < headerGroup.headers.length - 1) {
			headerCell.style.borderRight = "1px solid cyan";
		}
		headerCell.textContent = header.column.columnDef.header as string;
		headerRow.appendChild(headerCell);
	});

	container.appendChild(headerRow);
});

// Data rows using TanStack API
table.getRowModel().rows.forEach((row, rowIndex) => {
	const dataRow = document.createElement("div");
	dataRow.style.display = "flex";
	if (rowIndex % 2 === 1) {
		dataRow.style.backgroundColor = "#1a1a1a";
	}

	row.getVisibleCells().forEach((cell, i) => {
		const cellDiv = document.createElement("div");
		cellDiv.style.flex = "1";
		cellDiv.style.padding = "0 1ch";
		if (i < row.getVisibleCells().length - 1) {
			cellDiv.style.borderRight = "1px solid #444";
		}
		cellDiv.textContent = String(cell.getValue());
		dataRow.appendChild(cellDiv);
	});

	container.appendChild(dataRow);
});

document.body.appendChild(container);

// Show some TanStack table stats
const stats = document.createElement("div");
stats.style.marginTop = "1ch";
stats.style.color = "yellow";
stats.innerHTML = `
Powered by TanStack Table Core v8.21.3<br>
Rows: ${table.getRowModel().rows.length} | Columns: ${table.getAllColumns().length}
`;
document.body.appendChild(stats);

await new Promise<void>((r) => termdom.window.requestAnimationFrame(() => r()));
