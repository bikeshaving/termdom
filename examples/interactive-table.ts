#!/usr/bin/env bun
import { TermDOM } from "../src/termdom.js";
import { 
  createTable, 
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel 
} from "@tanstack/table-core";

const termdom = new TermDOM();
const { document } = termdom;

// Demo data
const rawData = [
  { name: "Alice Johnson", dept: "Engineering", salary: 95000, experience: 5, status: "Senior" },
  { name: "Bob Smith", dept: "Design", salary: 72000, experience: 3, status: "Mid" },
  { name: "Charlie Brown", dept: "Engineering", salary: 110000, experience: 8, status: "Senior" },
  { name: "Diana Prince", dept: "Marketing", salary: 68000, experience: 2, status: "Junior" },
  { name: "Eve Wilson", dept: "Engineering", salary: 88000, experience: 4, status: "Mid" },
  { name: "Frank Miller", dept: "Design", salary: 85000, experience: 6, status: "Senior" },
];

// Column definitions with custom rendering
const columns = [
  { 
    id: "name", 
    header: "Employee", 
    accessorKey: "name",
    enableSorting: true,
  },
  { 
    id: "dept", 
    header: "Department", 
    accessorKey: "dept",
    enableSorting: true,
  },
  { 
    id: "status", 
    header: "Level", 
    accessorKey: "status",
    enableSorting: true,
    cell: ({ getValue }: any) => {
      const level = getValue();
      return level === "Senior" ? "🔴 Sr" : 
             level === "Mid" ? "🟡 Mid" : "🟢 Jr";
    }
  },
  { 
    id: "experience", 
    header: "Years", 
    accessorKey: "experience",
    enableSorting: true,
  },
  { 
    id: "salary", 
    header: "Salary", 
    accessorKey: "salary",
    enableSorting: true,
    cell: ({ getValue }: any) => {
      const amount = getValue();
      return `$${amount.toLocaleString()}`;
    }
  },
];

// Table state 
let sorting = [{ id: "salary", desc: true }]; // Sort by salary descending initially
let globalFilter = "";

// Create table with sorting and filtering
const table = createTable({
  data: rawData,
  columns,
  state: {
    sorting,
    globalFilter,
  },
  onSortingChange: (updater: any) => {
    sorting = typeof updater === 'function' ? updater(sorting) : updater;
  },
  onGlobalFilterChange: (value: any) => {
    globalFilter = value;
  },
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
});

// Render the table
function renderTable() {
  // Clear previous content
  document.body.innerHTML = "";
  
  // Title
  const title = document.createElement("div");
  title.textContent = "💼 Employee Data Table (TanStack + TermDOM)";
  title.style.fontWeight = "bold";
  title.style.color = "cyan";
  title.style.marginBottom = "1ch";
  document.body.appendChild(title);

  // Filter info
  const filterInfo = document.createElement("div");
  filterInfo.textContent = `📊 Showing ${table.getFilteredRowModel().rows.length} of ${rawData.length} employees`;
  filterInfo.style.color = "green";
  filterInfo.style.marginBottom = "1ch";
  document.body.appendChild(filterInfo);

  // Table container
  const tableDiv = document.createElement("div");
  tableDiv.style.border = "1px solid cyan";

  // Headers
  table.getHeaderGroups().forEach(headerGroup => {
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
        headerCell.style.borderRight = "1px solid #555";
      }
      
      // Header text with sort indicator
      let headerText = header.column.columnDef.header as string;
      const sortDirection = header.column.getIsSorted();
      if (sortDirection) {
        headerText += sortDirection === 'asc' ? " ↑" : " ↓";
      }
      
      headerCell.textContent = headerText;
      headerRow.appendChild(headerCell);
    });
    
    tableDiv.appendChild(headerRow);
  });

  // Data rows
  table.getFilteredRowModel().rows.forEach((row, rowIndex) => {
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
        cellDiv.style.borderRight = "1px solid #333";
      }
      
      // Use custom cell renderer if available
      const cellValue = cell.column.columnDef.cell 
        ? (cell.column.columnDef.cell as any)({ getValue: () => cell.getValue() })
        : String(cell.getValue());
        
      cellDiv.textContent = cellValue;
      dataRow.appendChild(cellDiv);
    });
    
    tableDiv.appendChild(dataRow);
  });

  document.body.appendChild(tableDiv);

  // Summary stats
  const stats = document.createElement("div");
  stats.style.marginTop = "1ch";
  stats.style.color = "yellow";
  
  const avgSalary = table.getFilteredRowModel().rows
    .reduce((sum, row) => sum + row.original.salary, 0) / table.getFilteredRowModel().rows.length;
  
  const deptCounts = table.getFilteredRowModel().rows
    .reduce((acc: any, row) => {
      acc[row.original.department] = (acc[row.original.department] || 0) + 1;
      return acc;
    }, {});
  
  stats.innerHTML = `
📈 Analytics:
• Average Salary: $${Math.round(avgSalary).toLocaleString()}
• Department Breakdown: ${Object.entries(deptCounts).map(([dept, count]) => `${dept}: ${count}`).join(", ")}
• Sort: ${sorting.length ? `${sorting[0].id} ${sorting[0].desc ? "DESC" : "ASC"}` : "None"}
`;
  document.body.appendChild(stats);
}

// Initial render
renderTable();

await termdom.waitForRender();