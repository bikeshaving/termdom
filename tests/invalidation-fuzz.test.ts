/**
 * Invalidation checked against a full restyle. A random page takes a
 * random run of changes: classes, attributes, text, moves, focus by
 * script and by Tab, hover and presses by mouse, checks and typing. Then
 * every element's computed style and box, as the engine's caches have
 * them, must equal what a full restyle computes. A difference is a change
 * that failed to invalidate what its rules reach.
 *
 * FUZZ_SEED picks the seed and FUZZ_RUNS the number of pages, for a
 * deeper run than the suite's.
 */
import {expect, test} from "@b9g/libuild/test";
import fc from "fast-check";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

const SEED = Number(process.env.FUZZ_SEED ?? 20260928);
const RUNS = Number(process.env.FUZZ_RUNS ?? 40);

const CLASSES = ["a", "b", "c"];
const IDS = ["x", "y"];

// One simple selector's worth of test, in any compound position.
const simple = fc.oneof(
	fc.constantFrom(...CLASSES.map((name) => `.${name}`)),
	fc.constantFrom(...IDS.map((id) => `#${id}`)),
	fc.constantFrom("[data-k]", "[data-k=\"1\"]"),
	fc.constantFrom(
		":hover",
		":focus",
		":focus-visible",
		":focus-within",
		":active",
		":checked",
		":disabled",
		":empty",
		":first-child",
		":last-child",
		":nth-child(2)",
		":not(.a)",
		":is(.b, .c)",
		":has(> .a)",
		":has(+ .b)",
		":has(:checked)",
		":has(:focus)",
		":has(:hover)",
	),
);

const tag = fc.constantFrom("", "div", "span", "p", "button", "input", "li");

const compound = fc
	.tuple(tag, fc.array(simple, {minLength: 0, maxLength: 2}))
	.map(([name, parts]) => name + parts.join("") || "*");

const selector = fc
	.tuple(
		compound,
		fc.array(fc.tuple(fc.constantFrom(" ", " > ", " + ", " ~ "), compound), {
			maxLength: 2,
		}),
	)
	.map(([first, rest]) =>
		first + rest.map(([combinator, part]) => combinator + part).join(""),
	);

const declaration = fc.constantFrom(
	"color: rgb(255, 0, 0)",
	"color: rgb(0, 0, 255)",
	"font-weight: bold",
	"background-color: rgb(0, 128, 0)",
	"display: none",
	"display: block",
	"display: inline",
);

const rule = fc
	.tuple(selector, fc.array(declaration, {minLength: 1, maxLength: 2}))
	.map(([select, declarations]) => `${select} { ${declarations.join("; ")} }`);

const sheet = fc.array(rule, {minLength: 1, maxLength: 6});

interface NodeSpec {
	tag: "div" | "span" | "p" | "button" | "checkbox" | "text" | "ol" | "li";
	classes: string[];
	id: string | null;
	data: string | null;
	children: NodeSpec[];
	text: string;
}

const leafTag = fc.constantFrom("button", "checkbox", "text") as fc.Arbitrary<
	NodeSpec["tag"]
>;
const boxTag = fc.constantFrom("div", "span", "p", "ol", "li") as fc.Arbitrary<
	NodeSpec["tag"]
>;

const attributes = fc.record({
	classes: fc.subarray(CLASSES),
	id: fc.option(fc.constantFrom(...IDS), {nil: null}),
	data: fc.option(fc.constantFrom("", "1"), {nil: null}),
	text: fc.constantFrom("", "t", "word"),
});

const {node} = fc.letrec<{node: NodeSpec}>((tie) => ({
	node: fc.oneof({depthSize: "small", withCrossShrink: true}, fc
		.tuple(leafTag, attributes)
		.map(([leaf, rest]): NodeSpec => ({...rest, tag: leaf, children: []})), fc
		.tuple(boxTag, attributes, fc.array(tie("node"), {maxLength: 3}))
		.map(([box, rest, children]): NodeSpec => ({...rest, tag: box, children}))),
}));

const page = fc.array(node, {minLength: 1, maxLength: 4});

type Op =
	{kind: "class"; target: number; name: string} |
	{kind: "id"; target: number; id: string | null} |
	{kind: "data"; target: number; value: string | null} |
	{kind: "text"; target: number; text: string} |
	{kind: "move"; target: number; to: number} |
	{kind: "remove"; target: number} |
	{kind: "focus"; target: number} |
	{kind: "blur"} |
	{kind: "tab"} |
	{kind: "hover"; target: number} |
	{kind: "press"; target: number} |
	{kind: "release"} |
	{kind: "check"; target: number} |
	{kind: "disable"; target: number} |
	{kind: "type"; target: number} |
	{kind: "style"; target: number; style: string; api: boolean};

const target = fc.nat(40);

const op: fc.Arbitrary<Op> = fc.oneof(
	fc.record({
		kind: fc.constant("class" as const),
		target,
		name: fc.constantFrom(...CLASSES),
	}),
	fc.record({
		kind: fc.constant("id" as const),
		target,
		id: fc.option(fc.constantFrom(...IDS), {nil: null}),
	}),
	fc.record({
		kind: fc.constant("data" as const),
		target,
		value: fc.option(fc.constantFrom("", "1"), {nil: null}),
	}),
	fc.record({
		kind: fc.constant("text" as const),
		target,
		text: fc.constantFrom("", "u"),
	}),
	fc.record({kind: fc.constant("move" as const), target, to: target}),
	fc.record({kind: fc.constant("remove" as const), target}),
	fc.record({kind: fc.constant("focus" as const), target}),
	fc.constant({kind: "blur" as const}),
	fc.constant({kind: "tab" as const}),
	fc.record({kind: fc.constant("hover" as const), target}),
	fc.record({kind: fc.constant("press" as const), target}),
	fc.constant({kind: "release" as const}),
	fc.record({kind: fc.constant("check" as const), target}),
	fc.record({kind: fc.constant("disable" as const), target}),
	fc.record({kind: fc.constant("type" as const), target}),
	fc.record({
		kind: fc.constant("style" as const),
		target,
		style: fc.constantFrom(
			"",
			"color: rgb(1, 2, 3)",
			"display: none",
			"font-weight: bold",
			"padding-left: 2ch",
		),
		api: fc.boolean(),
	}),
);

function build(document: Document, spec: NodeSpec): Element {
	let element: Element;
	if (spec.tag === "checkbox" || spec.tag === "text") {
		element = document.createElement("input");
		element.setAttribute("type", spec.tag);
	} else {
		element = document.createElement(spec.tag);
		if (spec.text !== "") {
			element.append(spec.text);
		}
		for (const child of spec.children) {
			element.append(build(document, child));
		}
	}
	if (spec.tag === "button" || spec.tag === "div") {
		element.setAttribute("tabindex", "0");
	}
	for (const name of spec.classes) {
		element.classList.add(name);
	}
	if (spec.id !== null) {
		element.id = spec.id;
	}
	if (spec.data !== null) {
		element.setAttribute("data-k", spec.data);
	}
	return element;
}

const PROPERTIES = ["color", "font-weight", "background-color", "display"];

// What the engine reports for every element: its styles, and its box.
function snapshot(document: Document, window: TermDOM["window"]): string[] {
	return Array.from(document.body.querySelectorAll("*"), (element) => {
		const style = window.getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		return [
			element.tagName,
			...PROPERTIES.map((name) => style.getPropertyValue(name)),
			`${rect.left},${rect.top},${rect.width},${rect.height}`,
		].join(" ");
	});
}

function send(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from(data),
	);
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function apply(
	dom: TermDOM,
	terminal: MockProcess,
	change: Op,
): Promise<void> {
	const {document} = dom;
	const elements = Array.from(document.body.querySelectorAll("*"));
	const pick = (index: number): Element | undefined =>
		elements.length === 0 ? undefined : elements[index % elements.length];
	const cell = (element: Element): string => {
		const rect = element.getBoundingClientRect();
		return `${Math.floor(rect.left) + 1};${Math.floor(rect.top) + 1}`;
	};
	switch (change.kind) {
		case "class":
			pick(change.target)?.classList.toggle(change.name);
			break;
		case "id": {
			const element = pick(change.target);
			if (change.id === null) {
				element?.removeAttribute("id");
			} else if (element) {
				element.id = change.id;
			}
			break;
		}
		case "data": {
			const element = pick(change.target);
			if (change.value === null) {
				element?.removeAttribute("data-k");
			} else {
				element?.setAttribute("data-k", change.value);
			}
			break;
		}
		case "text": {
			const element = pick(change.target);
			if (element && element.localName !== "input") {
				element.textContent = change.text;
			}
			break;
		}
		case "move": {
			const element = pick(change.target);
			const destination = pick(change.to);
			if (
				element &&
				destination &&
				destination.localName !== "input" &&
				!element.contains(destination)
			) {
				destination.append(element);
			}
			break;
		}
		case "remove":
			pick(change.target)?.remove();
			break;
		case "focus":
			(pick(change.target) as HTMLElement | undefined)?.focus();
			break;
		case "blur":
			(document.activeElement as HTMLElement | null)?.blur();
			break;
		case "tab":
			await send(terminal, "\t");
			break;
		case "hover": {
			const element = pick(change.target);
			if (element) {
				await send(terminal, `\x1b[<35;${cell(element)}M`);
			}
			break;
		}
		case "press": {
			const element = pick(change.target);
			if (element) {
				await send(terminal, `\x1b[<0;${cell(element)}M`);
			}
			break;
		}
		case "release":
			await send(terminal, "\x1b[<0;1;1m");
			break;
		case "check": {
			const element = pick(change.target);
			if (element instanceof dom.window.HTMLInputElement) {
				element.checked = !element.checked;
			}
			break;
		}
		case "disable":
			pick(change.target)?.toggleAttribute("disabled");
			break;
		case "style": {
			const element = pick(change.target) as HTMLElement | undefined;
			if (element && change.api) {
				// Through the CSSOM, which must keep the attribute in step.
				element.style.cssText = change.style;
			} else if (element) {
				element.setAttribute("style", change.style);
			}
			break;
		}
		case "type": {
			const element = pick(change.target);
			if (element instanceof dom.window.HTMLInputElement) {
				element.focus();
				await send(terminal, "z");
			}
			break;
		}
	}
	await nextFrame(dom);
}

test(
	"every change restyles all that a full restyle would change",
	async () => {
		await fc.assert(fc.asyncProperty(
			sheet,
			page,
			fc.array(op, {minLength: 1, maxLength: 10}),
			async (rules, nodes, changes) => {
				const terminal = new MockProcess({cols: 40, rows: 20});
				const dom = new TermDOM({transport: terminal.transport});
				try {
					dom.attach();
					const {document, window} = dom;
					const style = document.createElement("style");
					style.textContent = rules.join("\n");
					document.head.append(style);
					for (const spec of nodes) {
						document.body.append(build(document, spec));
					}
					await nextFrame(dom);
					for (const change of changes) {
						await apply(dom, terminal, change);
					}
					const incremental = snapshot(document, window);
					// A new sheet drops every cached style, so what follows is
					// computed from nothing.
					document.head.append(document.createElement("style"));
					const full = snapshot(document, window);
					expect(incremental).toEqual(full);
				} finally {
					dom.dispose();
				}
			},
		), {seed: SEED, numRuns: RUNS, endOnFailure: true});
	},
	120_000,
);
