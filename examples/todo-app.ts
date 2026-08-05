#!/usr/bin/env bun
import {TermDOM} from "@b9g/termdom";

const termdom = new TermDOM();
const {document} = termdom;

// Styles
const style = document.createElement("style");
style.textContent = `
  .app { padding: 1ch 2ch; }
  .title { color: cyan; }
  .input-row { display: flex; flex-direction: row; gap: 1ch; }
  .input-row input { flex-grow: 1; }
  .add-btn { color: green; }
  .todo-list { padding-left: 0; }
  .todo-item {
    display: flex;
    flex-direction: row;
    gap: 1ch;
    padding: 0 1ch;
  }
  .todo-item:hover { background-color: #333; }
  .done { color: #666; }
  .done .text { text-decoration: underline; }
  .delete-btn { color: red; }
  .status { color: yellow; }
  .index { color: #666; }
`;
document.head.appendChild(style);

// App state
interface Todo {
	id: number;
	text: string;
	done: boolean;
}

let todos: Todo[] = [
	{id: 1, text: "Build the todo app", done: true},
	{id: 2, text: "Implement input fields", done: true},
	{id: 3, text: "Add focus navigation", done: false},
];
let nextId = 4;

// Build UI
const app = document.createElement("div");
app.className = "app";

const title = document.createElement("h2");
title.className = "title";
title.textContent = "Terminal Todo App";
app.appendChild(title);

// Input row
const inputRow = document.createElement("div");
inputRow.className = "input-row";

const input = document.createElement("input") as HTMLInputElement;
input.type = "text";
input.setAttribute("placeholder", "Add a new todo...");
inputRow.appendChild(input);

const addBtn = document.createElement("span");
addBtn.className = "add-btn";
addBtn.textContent = "[Enter to add]";
inputRow.appendChild(addBtn);

app.appendChild(inputRow);

// Todo list container
const todoList = document.createElement("div");
todoList.className = "todo-list";
app.appendChild(todoList);

// Status bar
const statusBar = document.createElement("div");
statusBar.className = "status";
app.appendChild(statusBar);

function renderTodos() {
	todoList.innerHTML = "";

	for (const [index, todo] of todos.entries()) {
		const item = document.createElement("div");
		item.className = "todo-item" + (todo.done ? " done" : "");

		// Only the first 9 are reachable by the 1-9 toggle/delete keys, so
		// only those get a number -- a 10th item's number would be a lie.
		const number = document.createElement("span");
		number.className = "index";
		number.textContent = index < 9 ? `${index + 1}.` : "  ";

		const checkbox = document.createElement("span");
		checkbox.textContent = todo.done ? "[x]" : "[ ]";

		const text = document.createElement("span");
		text.className = "text";
		text.textContent = todo.text;

		const del = document.createElement("span");
		del.className = "delete-btn";
		del.textContent = "(d)";

		item.appendChild(number);
		item.appendChild(checkbox);
		item.appendChild(text);
		item.appendChild(del);
		todoList.appendChild(item);
	}

	const remaining = todos.filter((t) => !t.done).length;
	const total = todos.length;
	statusBar.textContent = `${remaining} of ${total} remaining | Tab: focus input | Enter: add | 1-9: toggle | d+1-9: delete | q: quit`;
}

function addTodo(text: string) {
	if (!text.trim()) return;
	todos.push({id: nextId++, text: text.trim(), done: false});
	input.value = "";
	renderTodos();
}

function toggleTodo(index: number) {
	if (index >= 0 && index < todos.length) {
		todos[index].done = !todos[index].done;
		renderTodos();
	}
}

function deleteTodo(index: number) {
	if (index >= 0 && index < todos.length) {
		todos.splice(index, 1);
		renderTodos();
	}
}

document.body.appendChild(app);
renderTodos();
input.focus();

// Handle keyboard input
let pendingDelete = false;
document.addEventListener("keydown", (e: Event) => {
	const ke = e as KeyboardEvent;

	// Tab toggles focus between the input and the list. Without this, focus
	// (grabbed once at startup and never released) is permanently stuck on
	// the input: termdom's default Tab action cycles among focusable
	// elements, but input is the only one, so it re-focuses itself, and
	// every handler below that requires activeElement !== input -- toggle,
	// delete, quit -- becomes unreachable dead code.
	if (ke.key === "Tab") {
		ke.preventDefault();
		if (document.activeElement === input) {
			input.blur();
		} else {
			input.focus();
		}
		return;
	}

	if (ke.key === "q" && document.activeElement !== input) {
		process.exit(0);
	}

	if (ke.key === "Enter" && document.activeElement === input) {
		addTodo(input.value);
		ke.preventDefault();
	}

	// Number keys toggle todos
	if (ke.key >= "1" && ke.key <= "9" && document.activeElement !== input) {
		const index = parseInt(ke.key) - 1;
		if (pendingDelete) {
			deleteTodo(index);
			pendingDelete = false;
		} else {
			toggleTodo(index);
		}
	}

	// 'd' starts delete mode
	if (ke.key === "d" && document.activeElement !== input) {
		pendingDelete = true;
	}
});
