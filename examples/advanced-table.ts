#!/usr/bin/env bun
import {TermDOM} from "../src/termdom.js";
import {
	createTable,
	getCoreRowModel,
	getSortedRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
} from "@tanstack/table-core";

const termdom = new TermDOM();
const {document} = termdom;

// Sample data with more fields
const data = [
	{
		id: 1,
		name: "John Doe",
		email: "john@example.com",
		status: "Active",
		score: 95,
		department: "Engineering",
	},
	{
		id: 2,
		name: "Jane Smith",
		email: "jane@example.com",
		status: "Inactive",
		score: 88,
		department: "Design",
	},
	{
		id: 3,
		name: "Bob Wilson",
		email: "bob@example.com",
		status: "Pending",
		score: 92,
		department: "Engineering",
	},
	{
		id: 4,
		name: "Alice Brown",
		email: "alice@example.com",
		status: "Active",
		score: 87,
		department: "Marketing",
	},
	{
		id: 5,
		name: "Charlie Davis",
		email: "charlie@example.com",
		status: "Active",
		score: 91,
		department: "Engineering",
	},
	{
		id: 6,
		name: "Diana Prince",
		email: "diana@example.com",
		status: "Inactive",
		score: 96,
		department: "Design",
	},
];

// Advanced column definitions with formatting
const columns = [
	{
		id: "name",
		header: "Name",
		accessorKey: "name",
		size: 120,
	},
	{
		id: "department",
		header: "Dept",
		accessorKey: "department",
		size: 80,
	},
	{
		id: "status",
		header: "Status",
		accessorKey: "status",
		size: 80,
		cell: ({getValue}: any) => {
			const value = getValue();
			return value === "Active"
				? "✓ Active"
				: value === "Pending"
					? "⏳ Pending"
					: "✗ Inactive";
		},
	},
	{
		id: "score",
		header: "Score",
		accessorKey: "score",
		size: 60,
		cell: ({getValue}: any) => {
			const score = getValue();
			return score >= 90 ? `🔥 ${score}` : `${score}`;
		},
	},
];

// Create TanStack table with advanced features
let sortingState: any[] = [];

const table = createTable({
	data,
	columns,
	state: {
		sorting: sortingState,
	},
	onSortingChange: (updater: any) => {
		sortingState =
			typeof updater === "function" ? updater(sortingState) : updater;
	},
	getCoreRowModel: getCoreRowModel(),
	getSortedRowModel: getSortedRowModel(),
	getFilteredRowModel: getFilteredRowModel(),
	getPaginationRowModel: getPaginationRowModel(),
});

// Title
const title = document.createElement("div");
title.textContent = "🚀 Advanced TanStack Table Features";
title.style.fontWeight = "bold";
title.style.marginBottom = "1ch";
title.style.color = "yellow";
document.body.appendChild(title);

// Create the flexbox table
const tableContainer = document.createElement("div");
tableContainer.style.border = "1px solid yellow";
tableContainer.style.borderRadius = "1ch";
tableContainer.style.marginBottom = "1ch";

// Headers with sorting indicators
table.getHeaderGroups().forEach((headerGroup) => {
	const headerRow = document.createElement("div");
	headerRow.style.display = "flex";
	headerRow.style.backgroundColor = "#2a2a2a";
	headerRow.style.borderBottom = "1px solid yellow";

	headerGroup.headers.forEach((header, i) => {
		const headerCell = document.createElement("div");
		const column = header.column;
		const width = column.columnDef.size || 100;

		headerCell.style.width = `${width}px`;
		headerCell.style.padding = "0 1ch";
		headerCell.style.fontWeight = "bold";
		headerCell.style.color = "yellow";
		if (i < headerGroup.headers.length - 1) {
			headerCell.style.borderRight = "1px solid #444";
		}

		// Add sorting indicator
		let headerText = header.column.columnDef.header as string;
		const sortDirection = column.getIsSorted();
		if (sortDirection) {
			headerText += sortDirection === "asc" ? " ↑" : " ↓";
		}

		headerCell.textContent = headerText;
		headerRow.appendChild(headerCell);
	});

	tableContainer.appendChild(headerRow);
});

// Data rows with custom cell rendering
table.getRowModel().rows.forEach((row, rowIndex) => {
	const dataRow = document.createElement("div");
	dataRow.style.display = "flex";
	if (rowIndex % 2 === 1) {
		dataRow.style.backgroundColor = "#1a1a1a";
	}

	row.getVisibleCells().forEach((cell, i) => {
		const cellDiv = document.createElement("div");
		const column = cell.column;
		const width = column.columnDef.size || 100;

		cellDiv.style.width = `${width}px`;
		cellDiv.style.padding = "0 1ch";
		if (i < row.getVisibleCells().length - 1) {
			cellDiv.style.borderRight = "1px solid #444";
		}

		// Use custom cell renderer if available
		const cellValue = column.columnDef.cell
			? (column.columnDef.cell as any)({getValue: () => cell.getValue()})
			: String(cell.getValue());

		cellDiv.textContent = cellValue;
		dataRow.appendChild(cellDiv);
	});

	tableContainer.appendChild(dataRow);
});

document.body.appendChild(tableContainer);

// Stats and controls
const controls = document.createElement("div");
controls.style.color = "green";
controls.style.marginTop = "1ch";
controls.innerHTML = `
📊 Table Stats:
• Rows: ${table.getRowModel().rows.length}/${data.length} displayed
• Columns: ${table.getAllColumns().length} total
• Features: Sorting, Filtering, Pagination (headless)
• Page Size: ${table.getState().pagination.pageSize}
`;
document.body.appendChild(controls);

await termdom.waitForRender();
