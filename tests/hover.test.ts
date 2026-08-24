import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {transportFromProcess} from "../src/internal/pty.js";
import {nextFrame} from "./test-utils.js";
import {EventEmitter} from "events";

// A TTY-shaped process that records everything written to stdout, so tests
// can assert on the escape sequences that enable and disable motion
// reporting, and that feeds SGR reports back in through stdin.
class MockTTYStream extends EventEmitter {
	constructor(...args: ConstructorParameters<typeof EventEmitter>) {
		super(...args);
		this.isTTY = true;
	}

	isTTY: boolean;

	setRawMode(_mode: boolean): this {
		return this;
	}

	resume(): this {
		return this;
	}

	pause(): this {
		return this;
	}

	send(data: string): Promise<void> {
		this.emit("data", Buffer.from(data));
		// Input rides the transport's readable: delivery is a microtask away.
		return new Promise((resolve) => setTimeout(resolve, 0));
	}
}

class MockHoverProcess extends EventEmitter {
	constructor(...args: ConstructorParameters<typeof EventEmitter>) {
		super(...args);
		this.output = [];
		this.stdout = {
			isTTY: true,
			columns: 80,
			rows: 24,
			write: (chunk: any, encoding?: any, callback?: any): boolean => {
				this.output.push(String(chunk));
				if (typeof encoding === "function") {
					encoding();
				} else if (callback) {
					callback();
				}
				return true;
			},
		};
		this.stdin = new MockTTYStream();
		this.env = {
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
		};
	}

	output: string[];

	stdout: {
		isTTY: boolean;
		columns: number;
		rows: number;
		write: (chunk: any, encoding?: any, callback?: any) => boolean;
	};

	stdin: MockTTYStream;

	env: {TERM: string; COLORTERM: string};

	exit(_code?: number): never {
		throw new Error("Process exit");
	}

	get written(): string {
		return this.output.join("");
	}
}

const MOTION_ON = "\x1b[?1003h";
const MOTION_OFF = "\x1b[?1003l";

function makeApp(options: {html?: string} = {}): {
	proc: MockHoverProcess;
	termdom: TermDOM;
	document: Document;
} {
	const proc = new MockHoverProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(proc as any),
		html: options.html,
	});
	return {proc, termdom, document: termdom.document};
}

/** An SGR buttonless-motion report at a 1-based column and row. */
function motion(col: number, row: number): string {
	return `\x1b[<35;${col};${row}M`;
}

test("no motion reporting for an app that never observes hover", async () => {
	const {proc, termdom, document} = makeApp();
	const div = document.createElement("div");
	div.textContent = "plain";
	document.body.appendChild(div);
	await nextFrame(termdom);

	expect(proc.written).toContain("\x1b[?1002h");
	expect(proc.written).not.toContain(MOTION_ON);
	termdom.dispose();
});

test("a :hover rule turns motion reporting on; removing it turns it off", async () => {
	const {proc, termdom, document} = makeApp();
	const div = document.createElement("div");
	div.textContent = "target";
	document.body.appendChild(div);
	await nextFrame(termdom);
	expect(proc.written).not.toContain(MOTION_ON);

	const style = document.createElement("style");
	style.textContent = "div:hover { color: red; }";
	document.head.appendChild(style);
	await nextFrame(termdom);
	expect(proc.written).toContain(MOTION_ON);
	expect(proc.written).not.toContain(MOTION_OFF);

	style.remove();
	await nextFrame(termdom);
	expect(proc.written).toContain(MOTION_OFF);
	termdom.dispose();
});

test("a hover-family listener turns motion reporting on; removal turns it off", async () => {
	const {proc, termdom, document} = makeApp();
	const div = document.createElement("div");
	div.textContent = "target";
	document.body.appendChild(div);
	await nextFrame(termdom);
	expect(proc.written).not.toContain(MOTION_ON);

	const listener = () => {};
	document.addEventListener("mousemove", listener);
	expect(proc.written).toContain(MOTION_ON);

	document.removeEventListener("mousemove", listener);
	// The disable rides the session's write queue; let it flush.
	await new Promise((r) => setTimeout(r, 0));
	expect(proc.written).toContain(MOTION_OFF);
	termdom.dispose();
});

test("a window mouseover listener counts as observing hover", async () => {
	const {proc, termdom} = makeApp();
	await nextFrame(termdom);
	expect(proc.written).not.toContain(MOTION_ON);

	const listener = () => {};
	(termdom.window as any).addEventListener("mouseover", listener);
	// The enable rides the session's write queue; let it flush.
	await new Promise((r) => setTimeout(r, 0));
	expect(proc.written).toContain(MOTION_ON);
	(termdom.window as any).removeEventListener("mouseover", listener);
	await new Promise((r) => setTimeout(r, 0));
	expect(proc.written).toContain(MOTION_OFF);
	termdom.dispose();
});

test(":hover styles the element under the pointer and its ancestors", async () => {
	const {proc, termdom, document} = makeApp({
		html:
			"<style>" +
			"div:hover { color: rgb(255, 0, 0); }" +
			"section:hover { background-color: rgb(0, 0, 255); }" +
			"</style>" +
			"<section><div>first</div><div>second</div></section>",
	});
	await nextFrame(termdom);
	const [first, second] = Array.from(document.querySelectorAll("div"));
	const section = document.querySelector("section")!;

	await proc.stdin.send(motion(2, 1));
	await nextFrame(termdom);
	expect(first.matches(":hover")).toBe(true);
	expect(section.matches(":hover")).toBe(true);
	expect(second.matches(":hover")).toBe(false);
	const styles = termdom.window.getComputedStyle(first);
	expect(styles.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
	expect(
		termdom.window
			.getComputedStyle(section)
			.getPropertyValue("background-color"),
	).toBe("rgb(0, 0, 255)");

	await proc.stdin.send(motion(2, 2));
	await nextFrame(termdom);
	expect(first.matches(":hover")).toBe(false);
	expect(second.matches(":hover")).toBe(true);
	expect(termdom.window.getComputedStyle(first).getPropertyValue("color"))
		.toBe("rgb(0, 0, 0)");
	termdom.dispose();
});

test("boundary events fire in UI Events order with relatedTarget", async () => {
	const {proc, termdom, document} = makeApp({
		html: "<div id=parent><span id=a>aaaa</span><span id=b>bbbb</span></div>",
	});
	await nextFrame(termdom);
	const parent = document.getElementById("parent")!;
	const a = document.getElementById("a")!;
	const b = document.getElementById("b")!;

	const log: string[] = [];
	const related: Record<string, unknown> = {};
	for (const [element, name] of [
		[parent, "parent"],
		[a, "a"],
		[b, "b"],
	] as const) {
		for (const type of [
			"mouseover",
			"mouseout",
			"mouseenter",
			"mouseleave",
			"mousemove",
		]) {
			// Filtered to the element's own events: mouseover and mouseout
			// bubble, and a bubbled arrival would double-log.
			element.addEventListener(type, (event: any) => {
				if (event.target !== element) {
					return;
				}
				log.push(`${type}:${name}`);
				related[`${type}:${name}`] = event.relatedTarget;
			});
		}
	}

	await proc.stdin.send(motion(2, 1)); // over "a"
	await nextFrame(termdom);
	expect(log).toEqual([
		"mouseover:a",
		"mouseenter:parent",
		"mouseenter:a",
		"mousemove:a",
	]);
	expect(related["mouseover:a"]).toBe(null);

	log.length = 0;
	await proc.stdin.send(motion(6, 1)); // over "b"
	await nextFrame(termdom);
	expect(log).toEqual([
		"mouseout:a",
		"mouseleave:a",
		"mouseover:b",
		"mouseenter:b",
		"mousemove:b",
	]);
	expect(related["mouseout:a"]).toBe(b);
	expect(related["mouseover:b"]).toBe(a);
	termdom.dispose();
});

test("mouseenter does not bubble; mouseover does", async () => {
	const {proc, termdom, document} = makeApp({
		html: "<div id=parent><span id=a>aaaa</span></div>",
	});
	await nextFrame(termdom);
	const parent = document.getElementById("parent")!;
	const a = document.getElementById("a")!;

	let parentEnter = 0;
	let parentOver = 0;
	parent.addEventListener("mouseenter", () => parentEnter++);
	parent.addEventListener("mouseover", () => parentOver++);

	await proc.stdin.send(motion(2, 1)); // onto the span
	await nextFrame(termdom);
	expect(a.matches(":hover")).toBe(true);
	// The parent's own enter, once; the span's over, bubbled up to it.
	expect(parentEnter).toBe(1);
	expect(parentOver).toBe(1);
	termdom.dispose();
});

test("motion reports coalesce into at most one hit-test per frame", async () => {
	const {proc, termdom, document} = makeApp();
	for (let i = 0; i < 5; i++) {
		const div = document.createElement("div");
		div.textContent = `line ${i}`;
		document.body.appendChild(div);
	}
	await nextFrame(termdom);

	const moves: number[] = [];
	document.addEventListener("mousemove", (event: any) => {
		moves.push(event.clientY);
	});

	// A held pointer sweep delivers a report per cell in one chunk; the
	// frame handles the last position, not one per report.
	await proc.stdin.send(motion(2, 1) + motion(2, 2) + motion(2, 3));
	await nextFrame(termdom);
	expect(moves.length).toBeLessThan(3);
	expect(moves[moves.length - 1]).toBe(2);
	termdom.dispose();
});

test("@media (hover) answers hover, unconditionally", async () => {
	const {termdom} = makeApp();
	await nextFrame(termdom);
	expect(termdom.window.matchMedia("(hover: hover)").matches).toBe(true);
	expect(termdom.window.matchMedia("(hover: none)").matches).toBe(false);
	expect(termdom.window.matchMedia("(hover)").matches).toBe(true);
	termdom.dispose();
});

test("@media (hover: none) rules never apply", async () => {
	const html =
		"<style>@media (hover: none) { div { color: rgb(1, 2, 3); } }</style>" +
		"<div>target</div>";
	const {termdom, document} = makeApp({html});
	await nextFrame(termdom);
	const div = document.querySelector("div")!;
	expect(
		termdom.window.getComputedStyle(div).getPropertyValue("color"),
	).toBe("rgb(0, 0, 0)");
	termdom.dispose();
});

test("dispose turns motion reporting off", async () => {
	const {proc, termdom} = makeApp({
		html: "<style>div:hover { color: red; }</style><div>target</div>",
	});
	await nextFrame(termdom);
	expect(proc.written).toContain(MOTION_ON);

	termdom.dispose();
	await new Promise((r) => setTimeout(r, 0));
	expect(proc.written).toContain(MOTION_OFF);
});
