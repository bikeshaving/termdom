// The official Crank TodoMVC (github.com/bikeshaving/crank, examples/todomvc.js),
import {TermDOM} from "@b9g/termdom";
import type {Context} from "@b9g/crank";
import {jsx} from "@b9g/crank/standalone";
import {renderer} from "@b9g/crank/dom";

const term = new TermDOM();

term.attach();
const document = term.document;

const style = document.createElement("style");
style.textContent = `
  .todoapp { padding: 1ch 2ch; }
  .header h1 { color: cyan; font-weight: bold; }
  .header .new-todo { width: 100%; }
  .main { padding-top: 1px; }
  /* The toggle-all is a control over the LIST, not a list item: dim its
     label so the first todo doesn't appear to spawn a second checkbox. */
  .toggle-all { margin-right: 1ch; }
  label[for="toggle-all"] { color: #666; }
  .todo-list { padding-left: 0; list-style: none; }
  .todo-list li .view { display: flex; flex-direction: row; gap: 1ch; }
  .todo-list li.completed label { text-decoration: underline; color: #666; }
  /* Editing keeps the row's chrome: the view DISSOLVES (display:
     contents) so its checkbox and destroy button stay as flex siblings
     of the editor, only the label yields its place, and the editor
     shrink-wraps its text (width: auto -- field-sizing: content,
     effectively). */
  .todo-list li.editing { display: flex; flex-direction: row; gap: 1ch; }
  .todo-list li.editing .view { display: contents; }
  .todo-list li.editing .view label { display: none; }
  /* The editor takes the label's visual slot: the destroy button sits
     between them in the DOM, so order it after the editor. */
  .todo-list li.editing .destroy { order: 1; }
  .todo-list li .edit { width: auto; }
  .destroy { color: red; }
  /* An icon button: replace the UA "[ label ]" chrome with the glyph. */
  .destroy::before { content: none; }
  .destroy::after { content: "(x)"; }
  .footer { padding-top: 1px; color: yellow; }
  .todo-count strong { font-weight: bold; }
  .filters { display: flex; flex-direction: row; gap: 1ch; padding-left: 0; list-style: none; }
  .filters a { color: #888; }
  .filters a.selected { color: cyan; font-weight: bold; }
  .clear-completed { color: red; }
`;
document.head.appendChild(style);

// Custom TodoMVC event that bubbles by default
class TodoEvent extends CustomEvent<any> {
	constructor(type: string, detail: any = {}) {
		super(type, {
			bubbles: true,
			detail,
		});
	}
}

function* Header(this: Context) {
	let title = "";

	const oninput = (ev: any) => {
		title = ev.target.value;
	};

	const onkeydown = (ev: any) => {
		if (ev.key === "Enter" && title.trim()) {
			ev.preventDefault();
			this.dispatchEvent(new TodoEvent("todocreate", {title: title.trim()}));
			this.refresh(() => (title = ""));
		}
	};

	// Idiomatic Crank: this yields the component's props each iteration; {}
	// says none are used.

	for ({} of this) {
		yield jsx`
			<header class="header">
				<h1>todos</h1>
				<input
					class="new-todo"
					placeholder="What needs to be done?"
					value=${title}
					oninput=${oninput}
					onkeydown=${onkeydown}
					autofocus
				/>
			</header>
		`;
	}
}

function* TodoItem(this: Context, {todo}: any) {
	let editing = false;
	let editTitle = todo.title;

	const ontoggle = () => {
		this.dispatchEvent(
			new TodoEvent("todotoggle", {
				id: todo.id,
				completed: !todo.completed,
			}),
		);
	};

	const ondelete = () => {
		this.dispatchEvent(new TodoEvent("tododelete", {id: todo.id}));
	};

	const onedit = () => {
		this.refresh(() => {
			editing = true;
			editTitle = todo.title;
		});
	};

	const onsave = () => {
		if (editTitle.trim()) {
			this.dispatchEvent(
				new TodoEvent("todoedit", {
					id: todo.id,
					title: editTitle.trim(),
				}),
			);
		}
		this.refresh(() => (editing = false));
	};

	const oncancel = () => {
		this.refresh(() => {
			editing = false;
			editTitle = todo.title;
		});
	};

	const onkeydown = (ev: any) => {
		if (ev.key === "Enter") {
			onsave();
		} else if (ev.key === "Escape") {
			oncancel();
		}
	};

	for ({todo} of this) {
		yield jsx`
			<li class=${{completed: todo.completed, editing}}>
				<div class="view">
					<input
						class="toggle"
						type="checkbox"
						checked=${todo.completed}
						onchange=${ontoggle}
					/>
					<label ondblclick=${onedit}>${todo.title}</label>
					<button class="destroy" onclick=${ondelete}></button>
				</div>
				${
					editing &&
					jsx`
						<input
							class="edit"
							type="text"
							value=${editTitle}
							oninput=${(ev: any) => (editTitle = ev.target.value)}
							onkeydown=${onkeydown}
							onblur=${onsave}
							autofocus
						/>
					`
				}
			</li>
		`;
	}
}

function* TodoList(this: Context, {todos, filter}: any) {
	for ({todos, filter} of this) {
		const filteredTodos = todos.filter((todo: any) => {
			if (filter === "active") {
				return !todo.completed;
			}
			if (filter === "completed") {
				return todo.completed;
			}
			return true;
		});

		yield jsx`
			<ul class="todo-list">
				${filteredTodos.map(
					(todo: any) => jsx`<${TodoItem} key=${todo.id} todo=${todo} />`,
				)}
			</ul>
		`;
	}
}

function* Footer(this: Context, {todos, filter}: any) {
	const setFilter = (newFilter: string) => {
		this.dispatchEvent(new TodoEvent("filterchange", {filter: newFilter}));
	};

	const clearCompleted = () => {
		this.dispatchEvent(new TodoEvent("todoclearcompleted"));
	};

	for ({todos, filter} of this) {
		const activeCount = todos.filter((t: any) => !t.completed).length;
		const completedCount = todos.filter((t: any) => t.completed).length;

		yield jsx`
			<footer class="footer">
				<span class="todo-count">
					<strong>${activeCount}</strong> item${activeCount !== 1 ? "s" : ""} left
				</span>
				<ul class="filters">
					${["all", "active", "completed"].map(
						(f) => jsx`
							<li key=${f}>
								<a
									href="javascript:void(0)"
									onclick=${() => setFilter(f === "all" ? "" : f)}
									class=${{selected: filter === (f === "all" ? "" : f)}}
								>
									${f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
								</a>
							</li>
						`,
					)}
				</ul>
				${
					completedCount > 0 &&
					jsx`
						<button class="clear-completed" onclick=${clearCompleted}>
							Clear completed
						</button>
					`
				}
			</footer>
		`;
	}
}

function* App(this: Context) {
	let todos: any[] = [];
	let nextId = 1;
	let filter = "";

	this.addEventListener("todocreate", (ev: any) => {
		this.refresh(() => {
			todos.push({
				id: nextId++,
				title: ev.detail.title,
				completed: false,
			});
		});
	});

	this.addEventListener("todotoggle", (ev: any) => {
		this.refresh(() => {
			const todo = todos.find((t) => t.id === ev.detail.id);
			if (todo) {
				todo.completed = ev.detail.completed;
			}
		});
	});

	this.addEventListener("todoedit", (ev: any) => {
		this.refresh(() => {
			const todo = todos.find((t) => t.id === ev.detail.id);
			if (todo) {
				todo.title = ev.detail.title;
			}
		});
	});

	this.addEventListener("tododelete", (ev: any) => {
		this.refresh(() => {
			todos = todos.filter((t) => t.id !== ev.detail.id);
		});
	});

	this.addEventListener("todoclearcompleted", () => {
		this.refresh(() => {
			todos = todos.filter((t) => !t.completed);
		});
	});

	this.addEventListener("filterchange", (ev: any) => {
		this.refresh(() => {
			filter = ev.detail.filter;
		});
	});

	// Idiomatic Crank: this yields the component's props each iteration; {}
	// says none are used.

	for ({} of this) {
		yield jsx`
			<section class="todoapp">
				<${Header} />
				${
					todos.length > 0 &&
					jsx`
						<section class="main">
							<input
								id="toggle-all"
								class="toggle-all"
								type="checkbox"
								checked=${todos.every((t) => t.completed)}
								onchange=${(e: any) => {
									const completed = e.target.checked;
									this.refresh(() => {
										todos.forEach((t) => (t.completed = completed));
									});
								}}
							/>
							<label for="toggle-all">Mark all as complete</label>
							<${TodoList} todos=${todos} filter=${filter} />
							<${Footer} todos=${todos} filter=${filter} />
						</section>
					`
				}
			</section>
		`;
	}
}

renderer.render(jsx`<${App} />`, document.body);
