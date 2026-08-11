/**
 * A text field against a model of what a text field is.
 *
 * The model is a string and a caret. The field is a real focused `<input>` or
 * `<textarea>` fed real stdin bytes -- the decode path a terminal actually
 * takes, not synthesized key events -- and after every command its value and
 * selection must be what the model says. The vocabulary is the one
 * docs/guides/03-events-and-input.md documents: the readline motions and cuts,
 * plus bracketed paste, which arrives as one atomic insert.
 */
import {test} from "@b9g/libuild/test";
import fc from "fast-check";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "../tests/test-utils.js";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 25);
const SEED = Number(process.env.FC_SEED ?? 1);

type Command =
	| {kind: "type"; text: string}
	| {kind: "left"}
	| {kind: "right"}
	| {kind: "home"}
	| {kind: "end"}
	| {kind: "back"}
	| {kind: "forward"}
	| {kind: "killToEnd"}
	| {kind: "killToStart"}
	| {kind: "killWord"}
	| {kind: "deleteForward"}
	| {kind: "backspace"}
	| {kind: "newline"}
	| {kind: "paste"; text: string};

const BYTES: Record<string, string> = {
	left: "\x1b[D",
	right: "\x1b[C",
	home: "\x01",
	end: "\x05",
	back: "\x02",
	forward: "\x06",
	killToEnd: "\x0b",
	killToStart: "\x15",
	killWord: "\x17",
	deleteForward: "\x04",
	backspace: "\x7f",
	newline: "\x0a",
};

/** The bytes a terminal sends for a command. */
function encode(command: Command): string {
	if (command.kind === "type") return command.text;
	if (command.kind === "paste") {
		// A pasted newline arrives as a carriage return, the way a terminal
		// sends one.
		return `\x1b[200~${command.text.replace(/\n/g, "\r")}\x1b[201~`;
	}
	return BYTES[command.kind];
}

type Model = {value: string; caret: number};

const lineStart = (value: string, caret: number): number =>
	caret === 0 ? 0 : value.lastIndexOf("\n", caret - 1) + 1;

const lineEnd = (value: string, caret: number): number => {
	const index = value.indexOf("\n", caret);
	return index === -1 ? value.length : index;
};

const cut = (model: Model, from: number, to: number): Model => ({
	value: model.value.slice(0, from) + model.value.slice(to),
	caret: from,
});

const insert = (model: Model, text: string): Model => ({
	value: model.value.slice(0, model.caret) + text + model.value.slice(model.caret),
	caret: model.caret + text.length,
});

/** What the command does to the model, for a field that takes newlines or not. */
function step(model: Model, command: Command, multiline: boolean): Model {
	const {value, caret} = model;
	switch (command.kind) {
		case "type":
			return insert(model, command.text);
		case "paste":
			return insert(
				model,
				multiline ? command.text : command.text.replace(/\n/g, ""),
			);
		case "newline":
			return multiline ? insert(model, "\n") : model;
		case "left":
		case "back":
			return {value, caret: Math.max(0, caret - 1)};
		case "right":
		case "forward":
			return {value, caret: Math.min(value.length, caret + 1)};
		case "home":
			return {value, caret: lineStart(value, caret)};
		case "end":
			return {value, caret: lineEnd(value, caret)};
		case "killToEnd":
			return cut(model, caret, lineEnd(value, caret));
		case "killToStart":
			return cut(model, lineStart(value, caret), caret);
		case "killWord": {
			let start = caret;
			while (start > 0 && /\s/.test(value[start - 1])) start--;
			while (start > 0 && !/\s/.test(value[start - 1])) start--;
			return cut(model, start, caret);
		}
		case "deleteForward":
			return caret < value.length ? cut(model, caret, caret + 1) : model;
		case "backspace":
			return caret > 0 ? cut(model, caret - 1, caret) : model;
	}
}

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
	{arbitrary: fc.record({kind: fc.constant("type" as const), text: fc.constantFrom("a", "b", " ", "z", "ab", "hello")}), weight: 4},
	fc.record({kind: fc.constant("left" as const)}),
	fc.record({kind: fc.constant("right" as const)}),
	fc.record({kind: fc.constant("home" as const)}),
	fc.record({kind: fc.constant("end" as const)}),
	fc.record({kind: fc.constant("back" as const)}),
	fc.record({kind: fc.constant("forward" as const)}),
	fc.record({kind: fc.constant("killToEnd" as const)}),
	fc.record({kind: fc.constant("killToStart" as const)}),
	fc.record({kind: fc.constant("killWord" as const)}),
	fc.record({kind: fc.constant("deleteForward" as const)}),
	fc.record({kind: fc.constant("backspace" as const)}),
	fc.record({kind: fc.constant("newline" as const)}),
	fc.record({
		kind: fc.constant("paste" as const),
		text: fc.constantFrom("pasted", "two words", "a\nb", "x\ny\nz", ""),
	}),
);

const scriptArbitrary = fc.array(commandArbitrary, {minLength: 1, maxLength: 12});

async function play(tag: "input" | "textarea", script: Command[]) {
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({transport: terminal.transport}) as any;
	dom.document.body.innerHTML = `<${tag}></${tag}>`;
	await nextFrame(dom);
	const field = dom.document.querySelector(tag);
	field.focus();
	await nextFrame(dom);

	let model: Model = {value: "", caret: 0};
	const multiline = tag === "textarea";
	const trace: string[] = [];
	for (const command of script) {
		terminal.stdin.emit("data", Buffer.from(encode(command)));
		await nextFrame(dom);
		model = step(model, command, multiline);
		trace.push(
			`${command.kind}${"text" in command ? `(${JSON.stringify(command.text)})` : ""}` +
				` -> model ${JSON.stringify(model.value)}@${model.caret}` +
				` field ${JSON.stringify(field.value)}` +
				`@${field.selectionStart},${field.selectionEnd}`,
		);
		if (
			field.value !== model.value ||
			field.selectionStart !== model.caret ||
			field.selectionEnd !== model.caret
		) {
			dom.dispose();
			throw new Error(`<${tag}>\n${trace.join("\n")}`);
		}
	}
	dom.dispose();
}

test("an input edits the way the model says", async () => {
	await fc.assert(
		fc.asyncProperty(scriptArbitrary, (script: Command[]) =>
			play("input", script),
		),
		{numRuns: NUM_RUNS, seed: SEED, includeErrorInReport: true},
	);
}, 900000);

test("a textarea edits the way the model says", async () => {
	await fc.assert(
		fc.asyncProperty(scriptArbitrary, (script: Command[]) =>
			play("textarea", script),
		),
		{numRuns: NUM_RUNS, seed: SEED, includeErrorInReport: true},
	);
}, 900000);
