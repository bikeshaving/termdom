/**
 * The generated scene: a small document, a script of actions over it, and the
 * two ways of arriving at a frame.
 *
 * Both fast-check suites draw from this one vocabulary, so an action added
 * here widens what the frame oracles and the wire properties both search. The
 * script covers the DOM mutations, the two cameras (the window's and a scroll
 * box's), the wheel as it arrives off the wire, a terminal resize, and the
 * fullscreen screen switch -- the interleavings are the point, and the
 * documents stay small on purpose.
 *
 * Actions name their targets by a `data-f` id the generator assigns, never by
 * position, so an action whose target has been shrunk away is a no-op and
 * shrinking converges on a minimal document rather than a differently-shaped
 * one.
 */
import fc from "fast-check";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "../tests/test-utils.js";

export const SHEET = `
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
	.pane { height: 4em; overflow-y: scroll; }
	.box { border: 1px solid; }
	.round { border-radius: 1ch; }
	.center { display: flex; justify-content: center; align-items: center; }
	.rtl { direction: rtl; }
	.ltr { direction: ltr; }
	.mis { margin-inline-start: 2ch; }
	.mls { margin-left: 2ch; }
	.pie { padding-inline-end: 2ch; }
	.prewrap { white-space: pre-wrap; }
	.nowrap { white-space: nowrap; }
	.preline { white-space: pre-line; }
`;

/**
 * `SHAPES=1` widens the vocabulary past `.dim` with boxes, directions and the
 * top layer. The rules are always in the sheet and the classes only under the
 * flag, so a default sample is the sample it was before.
 */
const SHAPES = process.env.SHAPES === "1";

const BASE_CLASSES = [
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
	"pane",
];
const BASE_TAGS = ["div", "span", "p", "b", "em", "section", "li"];

const SHAPE_CLASSES = [
	"box",
	"round",
	"center",
	"rtl",
	"ltr",
	"mis",
	"mls",
	"pie",
	"prewrap",
	"nowrap",
	"preline",
];

const CLASSES = SHAPES ? [...BASE_CLASSES, ...SHAPE_CLASSES] : BASE_CLASSES;
const TAGS = SHAPES ? [...BASE_TAGS, "dialog"] : BASE_TAGS;

/**
 * Markup a leaf drops in whole, for shapes the recursive generator reaches
 * only by accident: consecutive whitespace-only inlines under `white-space:
 * pre`, a bordered auto-width block with block children centered as a flex
 * item, corners, logical against physical offsets under a direction, bidi and
 * width-uncertain runs inside a border, and the two top-layer states.
 */
const CLUSTERS = [
	"<span class=\"pre\"><b> </b><em> </em>x</span>",
	"<span class=\"pre\"><b> </b><b> </b><b> </b>y</span>",
	"<div class=\"center\"><div class=\"box\"><div>aa</div><div>bbbb</div></div></div>",
	"<div class=\"center\"><div class=\"box round\"><div>aa</div><div>bbbb</div></div></div>",
	"<div class=\"box round\" style=\"width: 8ch\">ab</div>",
	"<div class=\"box\" style=\"border-bottom-right-radius: 2ch; width: 7ch\">abc</div>",
	"<div class=\"rtl box\"><span class=\"mis\">ab</span><span class=\"mls\">cd</span></div>",
	"<div dir=\"rtl\" class=\"box pie\">الإصدار يعمل</div>",
	"<div class=\"box\">اب <b>cd</b> ef</div>",
	"<div class=\"box\">🙂🙂 <span>x</span></div>",
	"<div class=\"box\" style=\"width: 6ch\">ｗｉｄｅ ab</div>",
	"<span class=\"nowrap\">aa bb cc</span><span class=\"prewrap\">dd  ee</span>",
	"<dialog open><p>hi</p></dialog>",
	"<div popover>pop</div>",
	"<div class=\"box ltr\"><div class=\"rtl\">ab<b>cd</b>ef</div></div>",
];

/** Ids the actions may name; a miss is a no-op. */
const ID_POOL = 16;

type Tree =
	| {leaf: "text" | "space" | "comment"} |
	{cluster: string} |
	{tag: string; cls: string; children: Tree[]};

const treeArbitrary = fc.letrec<{node: Tree}>((tie) => ({
	node: fc.oneof(
		{maxDepth: 3, depthIdentifier: "node"},
		fc.constantFrom<Tree>({leaf: "text"}, {leaf: "space"}, {leaf: "comment"}),
		...(SHAPES ?
				[fc.constantFrom<Tree>(...CLUSTERS.map((cluster) => ({cluster})))] :
				[]),
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
		if ("cluster" in tree) {
			// Every start tag in the fragment gets an id of its own, so an
			// action can name what is inside a cluster and not only around it.
			return tree.cluster.replace(
				/<([a-z]+)(?=[\s>])/g,
				(_, name) => `<${name} data-f="e${elements++}"`,
			);
		}
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

export const documentArbitrary = fc
	.array(treeArbitrary, {minLength: 1, maxLength: 4})
	.map(toMarkup);

export type Action =
	| {kind: "class"; id: string; cls: string} |
	{kind: "style"; id: string; value: string} |
	{kind: "attr"; id: string; value: string} |
	{
		kind: "append";
		id: string;
		tag: string;
		cls: string;
		text: string;
		made: string;
	} |
	{kind: "prepend"; id: string; tag: string; text: string; made: string} |
	{kind: "remove"; id: string} |
	{kind: "move"; id: string; to: string} |
	{kind: "html"; id: string; value: string} |
	{kind: "text"; id: string; at: number; value: string} |
	{kind: "scroll"; top: number} |
	{kind: "wheel"; up: boolean; count: number; row: number} |
	{kind: "box"; id: string; top: number} |
	{kind: "size"; cols: number; rows: number} |
	{kind: "screen"; id: string} |
	{kind: "view"; id: string} |
	{kind: "dir"; id: string; value: string} |
	{kind: "open"; id: string} |
	{kind: "pop"; id: string; value: string} |
	{kind: "flash"; id: string; mode: "modal" | "dialog" | "popover"};

/** Any generated element, or the body. */
const idArbitrary = fc.oneof(
	fc.integer({min: 0, max: ID_POOL - 1}).map((n) => `e${n}`),
	fc.constant("body"),
);

/** A generated element only: the body is not a thing a script may unroot. */
const elementIdArbitrary = fc
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
			"height: 4em; overflow-y: scroll",
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
		text: fc.oneof(
			fc.constant(""),
			fc.integer({min: 0, max: 99}).map((n) => `n${n}`),
		),
		made: fc.integer({min: 0, max: 7}).map((n) => `m${n}`),
	}),
	fc.record({
		kind: fc.constant("prepend" as const),
		id: idArbitrary,
		tag: fc.constantFrom(...TAGS),
		text: fc.integer({min: 0, max: 99}).map((n) => `i${n}`),
		made: fc.integer({min: 0, max: 7}).map((n) => `m${n}`),
	}),
	fc.record({kind: fc.constant("remove" as const), id: elementIdArbitrary}),
	fc.record({
		kind: fc.constant("move" as const),
		id: elementIdArbitrary,
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
	// The wheel as it arrives: an SGR report off the wire, decoded by the
	// demultiplexer and dispatched, rather than a scrollTo the test made up.
	fc.record({
		kind: fc.constant("wheel" as const),
		up: fc.boolean(),
		count: fc.integer({min: 1, max: 3}),
		row: fc.integer({min: 1, max: 8}),
	}),
	// A scroll box's own camera: the band the terminal shifts under fixed
	// chrome, which is a different transform from the window's.
	fc.record({
		kind: fc.constant("box" as const),
		// `pane` names the fixed scroll box a caller's chrome contributes,
		// which is a miss in a document that has none.
		id: fc.oneof(elementIdArbitrary, fc.constant("pane")),
		top: fc.integer({min: 0, max: 12}),
	}),
	// A SIGWINCH mid-script. The sizes stay near the default so a small
	// document keeps fitting and nothing reflows off the top.
	fc.record({
		kind: fc.constant("size" as const),
		cols: fc.integer({min: 40, max: 60}),
		rows: fc.integer({min: 40, max: 60}),
	}),
	// The screen switch, toggled.
	fc.record({
		kind: fc.constant("screen" as const),
		id: fc.oneof(elementIdArbitrary, fc.constant("pane")),
	}),
	fc.record({kind: fc.constant("view" as const), id: idArbitrary}),
	...(SHAPES ?
			[
				fc.record({
					kind: fc.constant("dir" as const),
					id: idArbitrary,
					value: fc.constantFrom("", "ltr", "rtl", "auto"),
				}),
				fc.record({
					kind: fc.constant("open" as const),
					id: elementIdArbitrary,
				}),
				fc.record({
					kind: fc.constant("pop" as const),
					id: elementIdArbitrary,
					value: fc.constantFrom("", "auto", "manual"),
				}),
				fc.record({
					kind: fc.constant("flash" as const),
					id: elementIdArbitrary,
					mode: fc.constantFrom(
						"modal" as const,
						"dialog" as const,
						"popover" as const,
					),
				}),
			] :
			[]),
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
		case "wheel":
			return {...action, up: !action.up};
		case "box":
			return {kind: "box", id: action.id, top: 0};
		case "dir":
			return {kind: "dir", id: action.id, value: ""};
		case "open":
			return action;
		case "pop":
			return {kind: "pop", id: action.id, value: ""};
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
			if (inverse) {
				pending.push({action: inverse, at: script.length + step.gap});
			}
		}
		for (const {action} of pending) {
			script.push(action);
		}
		return script;
	});

export const runArbitrary = fc.record({
	document: documentArbitrary,
	script: scriptArbitrary,
});

export type Run = {
	document: {html: string; tokens: string[]};
	script: Action[];
};

/** A live engine and the emulator behind it, at the size it now stands. */
export interface Scene {
	dom: any;
	terminal: any;
	cols: number;
	rows: number;
}

export interface SceneOptions {
	cols?: number;
	rows?: number;
	/** Declare prior screen content, so the region anchors below it. */
	shared?: boolean;
	/** Rows of output already on the terminal when the engine attaches. */
	prior?: string[];
	/**
	 * Every chunk the engine puts on the wire, as it is written and before
	 * the emulator sees it. This is the whole observation channel the wire
	 * properties have: the transport's own bytes, with no seam into the
	 * engine.
	 */
	record?: (chunk: string) => void;
	/**
	 * Markup put in front of the generated document. A scroll box here is
	 * what makes the banded transform fire on documents this small.
	 */
	chrome?: string;
	/** Run after the document's first frame and after every action's. */
	onFrame?: (scene: Scene) => void | Promise<void>;
}

export function makeDOM(options: SceneOptions = {}): Scene {
	const cols = options.cols ?? 60;
	const rows = options.rows ?? 60;
	const terminal = new MockProcess({cols, rows});
	for (const line of options.prior ?? []) {
		terminal.stdout.write(line + "\r\n");
	}
	if (options.record) {
		const record = options.record;
		const stream = terminal.stdout as any;
		const wrote = stream.write.bind(stream);
		stream.write = (chunk: any, encoding?: any, callback?: any): boolean => {
			record(String(chunk));
			return wrote(chunk, encoding, callback);
		};
	}
	const dom = new TermDOM({
		transport: options.shared ? terminal.sharedTransport : terminal.transport,
	});
	const style = dom.document.createElement("style");
	style.textContent = SHEET;
	dom.document.head.appendChild(style);
	return {dom, terminal, cols, rows};
}

export function frameOf(terminal: any): string {
	return terminal
		.getPlainText()
		.split("\n")
		.map((line: string) => line.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n+$/, "");
}

const find = (document: any, id: string): any =>
	id === "body" ? document.body : document.querySelector(`[data-f="${id}"]`);

/**
 * Wait for the frame to stop changing. A resize debounces and then asks the
 * terminal where the cursor is, and a screen switch straddles two frames, so
 * the settled frame is the one that repeats.
 *
 * A frame that never repeats throws. Returning quietly is worse than useless
 * here: every caller reads geometry or pixels straight afterwards, so a scene
 * that ran out of ticks reports whatever it happened to be mid-flight, and a
 * property that fails on it looks exactly like one that found a real bug.
 */
export async function settle(scene: Scene, ticks = 30): Promise<void> {
	let last: string | null = null;
	let stable = 0;
	for (let tick = 0; tick < ticks; tick++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		await nextFrame(scene.dom);
		const frame = frameOf(scene.terminal);
		if (frame === last) {
			if (++stable >= 2) {
				return;
			}
		} else {
			stable = 0;
			last = frame;
		}
	}
	throw new Error(
		`The frame was still changing after ${ticks} ticks, so nothing read ` +
		"from this scene means anything.",
	);
}

/**
 * Run one action. Asynchronous for the ones that straddle frames: `flash`
 * shows a dialog or a popover and closes it, `screen` enters fullscreen and
 * leaves it, and `size` waits out the resize debounce.
 */
export async function apply(scene: Scene, action: Action): Promise<void> {
	const dom = scene.dom;
	const document = dom.document;
	if (action.kind === "scroll") {
		dom.window.scrollTo(0, action.top);
		return;
	}
	if (action.kind === "wheel") {
		const button = action.up ? 64 : 65;
		for (let i = 0; i < action.count; i++) {
			scene.terminal.stdin.simulateResponse(
				`\x1b[<${button};2;${action.row}M`,
			);
		}
		return;
	}
	if (action.kind === "size") {
		scene.cols = action.cols;
		scene.rows = action.rows;
		scene.terminal.resize(action.cols, action.rows);
		scene.terminal.emit("SIGWINCH");
		await settle(scene);
		return;
	}
	const element = find(document, action.id);
	if (!element) {
		return;
	}
	switch (action.kind) {
		case "box":
			element.scrollTop = action.top;
			return;
		case "screen":
			// A toggle, so a run can stand inside the alternate screen while
			// the next actions run and an observer can watch it there. play()
			// leaves it before the run ends.
			try {
				if (document.fullscreenElement) {
					await document.exitFullscreen();
				} else {
					await element.requestFullscreen();
				}
			} catch (_err) {
				return;
			}
			await nextFrame(dom);
			await nextFrame(dom);
			return;
		case "dir":
			if (action.value) {
				element.setAttribute("dir", action.value);
			} else {
				element.removeAttribute("dir");
			}
			return;
		case "open":
			if (element.tagName === "DIALOG") {
				element.toggleAttribute("open");
			}
			return;
		case "pop":
			if (action.value) {
				element.setAttribute("popover", action.value);
			} else {
				element.removeAttribute("popover");
			}
			return;
		case "flash": {
			// Showing what is already shown is a spec'd throw, not a finding.
			if (action.mode === "popover") {
				if (!element.hasAttribute("popover")) {
					return;
				}
				try {
					element.showPopover();
				} catch (_err) {
					return;
				}
				await nextFrame(dom);
				try {
					element.hidePopover();
				} catch (_err) {
					/* an auto popover may already have been dismissed */
				}
				return;
			}
			if (element.tagName !== "DIALOG" || element.hasAttribute("open")) {
				return;
			}
			try {
				if (action.mode === "modal") {
					element.showModal();
				} else {
					element.show();
				}
			} catch (_err) {
				return;
			}
			await nextFrame(dom);
			element.close();
			return;
		}
	}
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
			if (action.kind === "append" && action.cls) {
				child.className = action.cls;
			}
			if (action.text) {
				child.textContent = action.text;
			}
			if (action.kind === "append") {
				element.appendChild(child);
			} else if (element.firstChild) {
				element.insertBefore(child, element.firstChild);
			} else {
				element.appendChild(child);
			}
			break;
		}
		case "remove":
			element.remove();
			break;
		case "move": {
			const to = find(document, action.to);
			if (!to || to === element || element.contains(to)) {
				return;
			}
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
					if (child.nodeType === 3) {
						texts.push(child);
					} else {
						walk(child);
					}
				}
			};
			walk(element);
			if (texts[action.at]) {
				texts[action.at].data = action.value;
			}
			break;
		}
	}
}

/**
 * Build, run the script with a frame between each action, park the camera.
 *
 * Parking leaves the screen switch behind and the window at the top, so a run
 * ends in the state a fresh render of the same tree would start in: the
 * frame oracles compare what is left with what is drawn once, and neither the
 * alternate screen nor a scrolled camera is part of the tree.
 */
export async function play(
	run: Run,
	options: SceneOptions = {},
): Promise<Scene> {
	const scene = makeDOM(options);
	scene.dom.document.body.innerHTML =
		(options.chrome ?? "") + run.document.html;
	await nextFrame(scene.dom);
	await options.onFrame?.(scene);
	for (const action of run.script) {
		await apply(scene, action);
		await nextFrame(scene.dom);
		await options.onFrame?.(scene);
	}
	if (scene.dom.document.fullscreenElement) {
		await scene.dom.document.exitFullscreen();
		await nextFrame(scene.dom);
	}
	scene.dom.window.scrollTo(0, 0);
	await nextFrame(scene.dom);
	await options.onFrame?.(scene);
	return scene;
}

/** The same final tree, transferred into an untouched engine and drawn once. */
export async function replay(
	dom: any,
	options: SceneOptions = {},
): Promise<Scene> {
	const scene = makeDOM(options);
	for (const attribute of Array.from(dom.document.body.attributes) as any[]) {
		scene.dom.document.body.setAttribute(attribute.name, attribute.value);
	}
	for (const child of Array.from(dom.document.body.childNodes) as any[]) {
		scene.dom.document.body.appendChild(
			scene.dom.document.importNode(child, true),
		);
	}
	await nextFrame(scene.dom);
	return scene;
}
