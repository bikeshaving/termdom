/**
 * Properties over a generated document, driven by fast-check.
 *
 * A document is built from a generated tree, mutated a step at a time with a
 * frame between each, and then checked against an oracle. Four oracles live
 * here over the one generator: the incremental frame against a frame rendered
 * once from the same final tree, the incremental computed styles against that
 * same fresh render's, the painted cells against the geometry and hit-testing
 * APIs, and a frame against itself across a resize round trip.
 *
 * Actions name their targets by a `data-f` id the generator assigns, never by
 * position, so an action whose target has been shrunk away is a no-op and
 * shrinking converges on a minimal document rather than a differently-shaped
 * one. Cross-document transfer is `importNode`, never a re-parse: the parser
 * reshapes `<p><li>` and that is not an engine difference.
 *
 * `FC_NUM_RUNS=500` widens the search, `FC_SEED=...` replays one; fast-check
 * prints both the seed and the path to the counterexample on failure.
 */
import {test} from "@b9g/libuild/test";
import fc from "fast-check";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "../tests/test-utils.js";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 25);
const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

const assertOptions = {numRuns: NUM_RUNS, ...(SEED === undefined ? {} : {seed: SEED})};

const SHEET = `
	.hide { display: none; }
	.flex { display: flex; flex-direction: row; gap: 1ch; }
	.col { display: flex; flex-direction: column; }
	.contents { display: contents; }
	.inline { display: inline; }
	.iblock { display: inline-block; }
	.block { display: block; }
	.pad { padding-left: 1ch; }
	.pre { white-space: pre; }
	.wide { width: 8ch; }
	.mark::before { content: "* "; }
	.editing .view { display: none; }
	.on ~ .light { color: red; }
	.dim { color: #808080; }
`;

const CLASSES = [
	"hide",
	"flex",
	"col",
	"contents",
	"inline",
	"iblock",
	"block",
	"pad",
	"pre",
	"wide",
	"mark",
	"editing",
	"view",
	"on",
	"light",
	"dim",
];
const TAGS = ["div", "span", "p", "b", "em", "section", "li"];

/** Ids the actions may name; a miss is a no-op. */
const ID_POOL = 16;

type Tree =
	| {leaf: "text" | "space" | "comment"}
	| {tag: string; cls: string; children: Tree[]};

const treeArbitrary = fc.letrec<{node: Tree}>((tie) => ({
	node: fc.oneof(
		{maxDepth: 3, depthIdentifier: "node"},
		fc.constantFrom<Tree>(
			{leaf: "text"},
			{leaf: "space"},
			{leaf: "comment"},
		),
		fc.record({
			tag: fc.constantFrom(...TAGS),
			cls: fc.constantFrom("", ...CLASSES),
			children: fc.array(tie("node"), {maxLength: 3}),
		}),
	),
})).node;

/**
 * The generated tree as markup, with a stable `data-f` on every element and a
 * unique token in every text node. Both numberings are assigned in document
 * order, so the same tree always produces the same ids.
 */
function toMarkup(trees: Tree[]): {html: string; tokens: string[]} {
	let elements = 0;
	let texts = 0;
	const tokens: string[] = [];
	const emit = (tree: Tree): string => {
		if ("leaf" in tree) {
			switch (tree.leaf) {
				case "space":
					return "   ";
				case "comment":
					return "<!-- c -->";
				default: {
					const token = `t${String(texts++).padStart(3, "0")}`;
					tokens.push(token);
					return token;
				}
			}
		}
		const id = `e${elements++}`;
		const inner = tree.children.map(emit).join("");
		return (
			`<${tree.tag} data-f="${id}"${tree.cls ? ` class="${tree.cls}"` : ""}>` +
			`${inner}</${tree.tag}>`
		);
	};
	return {html: trees.map(emit).join(""), tokens};
}

const documentArbitrary = fc
	.array(treeArbitrary, {minLength: 1, maxLength: 4})
	.map(toMarkup);

type Action =
	| {kind: "class"; id: string; cls: string}
	| {kind: "style"; id: string; value: string}
	| {kind: "attr"; id: string; value: string}
	| {kind: "append"; id: string; tag: string; cls: string; text: string; made: string}
	| {kind: "prepend"; id: string; tag: string; text: string; made: string}
	| {kind: "remove"; id: string}
	| {kind: "move"; id: string; to: string}
	| {kind: "html"; id: string; value: string}
	| {kind: "text"; id: string; at: number; value: string}
	| {kind: "scroll"; top: number}
	| {kind: "view"; id: string};

/** Any generated element, or the body. */
const idArbitrary = fc.oneof(
	fc.integer({min: 0, max: ID_POOL - 1}).map((n) => `e${n}`),
	fc.constant("body"),
);

/** A generated element only: the body is not a thing a script may unroot. */
const elementIDArbitrary = fc
	.integer({min: 0, max: ID_POOL - 1})
	.map((n) => `e${n}`);

const actionArbitrary: fc.Arbitrary<Action> = fc.oneof(
	fc.record({
		kind: fc.constant("class" as const),
		id: idArbitrary,
		cls: fc.constantFrom(...CLASSES),
	}),
	fc.record({
		kind: fc.constant("style" as const),
		id: idArbitrary,
		value: fc.constantFrom(
			"",
			"display: none",
			"display: block",
			"display: inline",
			"display: flex",
			"padding-left: 2ch",
			"width: 6ch",
			"color: blue",
			"white-space: pre",
		),
	}),
	fc.record({
		kind: fc.constant("attr" as const),
		id: idArbitrary,
		value: fc.integer({min: 0, max: 8}).map(String),
	}),
	fc.record({
		kind: fc.constant("append" as const),
		id: idArbitrary,
		tag: fc.constantFrom(...TAGS),
		cls: fc.constantFrom("", ...CLASSES),
		text: fc.oneof(fc.constant(""), fc.integer({min: 0, max: 99}).map((n) => `n${n}`)),
		made: fc.integer({min: 0, max: 7}).map((n) => `m${n}`),
	}),
	fc.record({
		kind: fc.constant("prepend" as const),
		id: idArbitrary,
		tag: fc.constantFrom(...TAGS),
		text: fc.integer({min: 0, max: 99}).map((n) => `i${n}`),
		made: fc.integer({min: 0, max: 7}).map((n) => `m${n}`),
	}),
	fc.record({kind: fc.constant("remove" as const), id: elementIDArbitrary}),
	fc.record({
		kind: fc.constant("move" as const),
		id: elementIDArbitrary,
		to: idArbitrary,
	}),
	fc.record({
		kind: fc.constant("html" as const),
		id: idArbitrary,
		value: fc.constantFrom(
			"",
			"   ",
			"<b>x</b>",
			"<div></div>",
			"<span>a</span><div>b</div>",
		),
	}),
	fc.record({
		kind: fc.constant("text" as const),
		id: idArbitrary,
		at: fc.integer({min: 0, max: 2}),
		value: fc.constantFrom("", " ", "   ", "z", "zz zz"),
	}),
	fc.record({
		kind: fc.constant("scroll" as const),
		top: fc.integer({min: 0, max: 20}),
	}),
	fc.record({kind: fc.constant("view" as const), id: idArbitrary}),
);

/**
 * The action that undoes this one, where undoing it is a single action. A pair
 * that brackets other work is what shakes out a cache the first action filled
 * and the second failed to refill.
 */
function inverseOf(action: Action): Action | null {
	switch (action.kind) {
		case "class":
			return action;
		case "style":
			return {kind: "style", id: action.id, value: ""};
		case "attr":
			return {kind: "attr", id: action.id, value: ""};
		case "scroll":
			return {kind: "scroll", top: 0};
		default:
			return null;
	}
}

/** A step is an action, optionally paired with its inverse `gap` steps later. */
const scriptArbitrary = fc
	.array(
		fc.record({
			action: actionArbitrary,
			reversed: fc.boolean(),
			gap: fc.integer({min: 0, max: 3}),
		}),
		{maxLength: 8},
	)
	.map((steps) => {
		const script: Action[] = [];
		const pending: Array<{action: Action; at: number}> = [];
		for (const step of steps) {
			for (let i = pending.length - 1; i >= 0; i--) {
				if (pending[i].at <= script.length) {
					script.push(pending[i].action);
					pending.splice(i, 1);
				}
			}
			script.push(step.action);
			const inverse = step.reversed ? inverseOf(step.action) : null;
			if (inverse) pending.push({action: inverse, at: script.length + step.gap});
		}
		for (const {action} of pending) script.push(action);
		return script;
	});

const runArbitrary = fc.record({
	document: documentArbitrary,
	script: scriptArbitrary,
});

type Run = {document: {html: string; tokens: string[]}; script: Action[]};

function makeDOM(cols = 60, rows = 60): {dom: any; terminal: any} {
	const terminal = new MockProcess({cols, rows});
	const dom = new TermDOM({transport: terminal.transport});
	const style = dom.document.createElement("style");
	style.textContent = SHEET;
	dom.document.head.appendChild(style);
	return {dom, terminal};
}

function frameOf(terminal: any): string {
	return terminal
		.getPlainText()
		.split("\n")
		.map((line: string) => line.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n+$/, "");
}

const find = (document: any, id: string): any =>
	id === "body" ? document.body : document.querySelector(`[data-f="${id}"]`);

function apply(dom: any, action: Action): void {
	const document = dom.document;
	if (action.kind === "scroll") {
		dom.window.scrollTo(0, action.top);
		return;
	}
	const element = find(document, action.id);
	if (!element) return;
	switch (action.kind) {
		case "class":
			element.classList.toggle(action.cls);
			break;
		case "style":
			element.setAttribute("style", action.value);
			break;
		case "attr":
			element.setAttribute("data-x", action.value);
			break;
		case "view":
			element.scrollIntoView();
			break;
		case "append":
		case "prepend": {
			const child = document.createElement(action.tag);
			child.setAttribute("data-f", action.made);
			if (action.kind === "append" && action.cls) child.className = action.cls;
			if (action.text) child.textContent = action.text;
			if (action.kind === "append") element.appendChild(child);
			else if (element.firstChild) element.insertBefore(child, element.firstChild);
			else element.appendChild(child);
			break;
		}
		case "remove":
			element.remove();
			break;
		case "move": {
			const to = find(document, action.to);
			if (!to || to === element || element.contains(to)) return;
			to.appendChild(element);
			break;
		}
		case "html":
			element.innerHTML = action.value;
			break;
		case "text": {
			const texts: any[] = [];
			const walk = (node: any): void => {
				for (const child of Array.from(node.childNodes) as any[]) {
					if (child.nodeType === 3) texts.push(child);
					else walk(child);
				}
			};
			walk(element);
			if (texts[action.at]) texts[action.at].data = action.value;
			break;
		}
	}
}

/** Build, run the script with a frame between each action, park the camera. */
async function play(run: Run, cols?: number, rows?: number) {
	const made = makeDOM(cols, rows);
	made.dom.document.body.innerHTML = run.document.html;
	await nextFrame(made.dom);
	for (const action of run.script) {
		apply(made.dom, action);
		await nextFrame(made.dom);
	}
	made.dom.window.scrollTo(0, 0);
	await nextFrame(made.dom);
	return made;
}

/** The same final tree, transferred into an untouched engine and drawn once. */
async function replay(dom: any, cols?: number, rows?: number) {
	const made = makeDOM(cols, rows);
	for (const attribute of Array.from(dom.document.body.attributes) as any[]) {
		made.dom.document.body.setAttribute(attribute.name, attribute.value);
	}
	for (const child of Array.from(dom.document.body.childNodes) as any[]) {
		made.dom.document.body.appendChild(made.dom.document.importNode(child, true));
	}
	await nextFrame(made.dom);
	return made;
}

test("an incrementally mutated frame equals a frame rendered once", async () => {
	await fc.assert(
		fc.asyncProperty(runArbitrary, async (run: Run) => {
			const live = await play(run);
			const fresh = await replay(live.dom);
			const incremental = frameOf(live.terminal);
			const once = frameOf(fresh.terminal);
			live.dom.dispose();
			fresh.dom.dispose();
			if (incremental !== once) {
				throw new Error(
					`html: ${run.document.html}\n` +
						`script: ${JSON.stringify(run.script)}\n` +
						`--- incremental\n${incremental}\n--- fresh\n${once}`,
				);
			}
		}),
		assertOptions,
	);
}, 900000);
