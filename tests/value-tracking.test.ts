/**
 * What a user edit writes, and what it does not touch.
 *
 * A browser's editing internals change a control's value itself, never the
 * `value` IDL attribute over it -- so a page that replaces the accessor on the
 * element (the shape every controlled-input library uses to tell a user's
 * keystroke from its own assignment) sees its setter run for its own writes
 * and never for typing. The same distinction holds here, and the dirty value
 * flag follows the HTML Standard on both sides of it.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function type(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	// Input rides the transport's readable: delivery is a microtask away.
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wrap an element's own `value`/`checked` accessor the way an input-tracking
 * library does: an instance property shadowing the prototype's, delegating
 * both ways, remembering every value the page assigns.
 */
function trackAccessor(node: any, property: "value" | "checked"): {
	assigned: unknown[];
	drifted: () => boolean;
} {
	const descriptor = Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(node),
		property,
	)!;
	const assigned: unknown[] = [];
	let seen = node[property];
	Object.defineProperty(node, property, {
		configurable: true,
		enumerable: false,
		get() {
			return descriptor.get!.call(this);
		},
		set(value: unknown) {
			assigned.push(value);
			seen = value;
			descriptor.set!.call(this, value);
		},
	});
	return {
		assigned,

		/** Whether the element's value has moved out from under the tracker. */
		drifted: () => node[property] !== seen,
	};
}

/** A focused field in a running terminal, ready to be typed into. */
async function textControlFixture(tag: "input" | "textarea"): Promise<
	{terminal: MockProcess; dom: TermDOM; field: any}
> {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((resolve) => setTimeout(resolve, 0));
	const field = dom.document.createElement(tag) as any;
	dom.document.body.appendChild(field);
	field.focus();
	await nextFrame(dom);
	return {terminal, dom, field};
}

/* ------------------------------------------- the user's edit, not the page's */

test("typing an input never runs the page's value setter", async () => {
	const {terminal, dom, field} = await textControlFixture("input");
	const tracker = trackAccessor(field, "value");
	const events: string[] = [];
	field.addEventListener("input", () => events.push("input"));

	await type(terminal, "hi");

	expect(field.value).toBe("hi");
	expect(tracker.assigned).toEqual([]);
	expect(tracker.drifted()).toBe(true);
	expect(events).toEqual(["input", "input"]);

	dom.dispose();
});

test("backspace and paste stay off the page's value setter", async () => {
	const {terminal, dom, field} = await textControlFixture("input");
	await type(terminal, "abc");
	const tracker = trackAccessor(field, "value");

	await type(terminal, "\x7f");
	expect(field.value).toBe("ab");
	// A bracketed paste is one atomic insert.
	await type(terminal, "\x1b[200~xyz\x1b[201~");
	expect(field.value).toBe("abxyz");
	expect(tracker.assigned).toEqual([]);

	dom.dispose();
});

test("typing a textarea never runs the page's value setter", async () => {
	const {terminal, dom, field} = await textControlFixture("textarea");
	const tracker = trackAccessor(field, "value");
	const events: string[] = [];
	field.addEventListener("input", () => events.push("input"));

	await type(terminal, "ab");
	await type(terminal, "\r");
	await type(terminal, "c");

	expect(field.value).toBe("ab\nc");
	expect(tracker.assigned).toEqual([]);
	expect(tracker.drifted()).toBe(true);
	expect(events.length).toBe(4);

	dom.dispose();
});

test("clicking a checkbox never runs the page's checked setter", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const box = dom.document.createElement("input") as any;
	box.type = "checkbox";
	dom.document.body.appendChild(box);
	await nextFrame(dom);
	const tracker = trackAccessor(box, "checked");
	const events: string[] = [];
	box.addEventListener("input", () => events.push("input"));
	box.addEventListener("change", () => events.push("change"));

	box.click();

	expect(box.checked).toBe(true);
	expect(tracker.assigned).toEqual([]);
	expect(tracker.drifted()).toBe(true);
	expect(events).toEqual(["input", "change"]);

	dom.dispose();
});

test("the page's own assignment still runs its wrapped setter", async () => {
	const {dom, field} = await textControlFixture("input");
	const tracker = trackAccessor(field, "value");

	field.value = "written";

	expect(field.value).toBe("written");
	expect(tracker.assigned).toEqual(["written"]);
	expect(tracker.drifted()).toBe(false);

	dom.dispose();
});

test("a page assignment after typing runs the setter, and wins", async () => {
	const {terminal, dom, field} = await textControlFixture("input");
	await type(terminal, "typed");
	const tracker = trackAccessor(field, "value");

	field.value = "typed!";
	await type(terminal, "?");

	expect(field.value).toBe("typed!?");
	expect(tracker.assigned).toEqual(["typed!"]);

	dom.dispose();
});

/* ------------------------------------------------------ the dirty value flag */

test("typing sets an input's dirty value flag", async () => {
	const {terminal, dom, field} = await textControlFixture("input");
	field.setAttribute("value", "default");
	expect(field.value).toBe("default");

	await type(terminal, "!");

	// The attribute stops feeding the value once the user has edited it, and
	// keeps answering for the default.
	expect(field.value).toBe("!default");
	field.setAttribute("value", "ignored now");
	expect(field.value).toBe("!default");
	expect(field.defaultValue).toBe("ignored now");

	dom.dispose();
});

test("a form reset clears the flag a user edit set", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((resolve) => setTimeout(resolve, 0));
	const {document} = dom;
	document.body.innerHTML = "<form><input value=\"default\"><textarea>child text</textarea></form>";
	const form = document.querySelector("form") as any;
	const input = document.querySelector("input") as any;
	const textarea = document.querySelector("textarea") as any;
	input.focus();
	await nextFrame(dom);
	await type(terminal, "!");
	textarea.focus();
	await nextFrame(dom);
	await type(terminal, "!");

	expect(input.value).toBe("!default");
	expect(textarea.value).toBe("!child text");

	form.reset();

	expect(input.value).toBe("default");
	expect(textarea.value).toBe("child text");
	// And the attribute feeds the value again, the flag being clear.
	input.setAttribute("value", "moved");
	expect(input.value).toBe("moved");

	dom.dispose();
});

test("typing sets a textarea's dirty value flag", async () => {
	const {terminal, dom, field} = await textControlFixture("textarea");
	field.appendChild(dom.document.createTextNode("child"));
	expect(field.value).toBe("child");

	await type(terminal, "!");

	expect(field.value).toBe("!child");
	field.firstChild.data = "ignored now";
	expect(field.value).toBe("!child");
	expect(field.defaultValue).toBe("ignored now");

	dom.dispose();
});

/* ------------------------------------------------- what the widget renders */

test("a user edit reaches the rendered value, not only the IDL attribute", async () => {
	const {terminal, dom, field} = await textControlFixture("input");
	// A page that replaces the accessor outright still sees its field paint.
	Object.defineProperty(field, "value", {
		configurable: true,
		get: () => "not the value",
		set: () => {},
	});

	await type(terminal, "painted");
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("painted");

	dom.dispose();
});
