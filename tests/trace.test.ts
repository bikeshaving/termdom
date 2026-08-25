/**
 * The debugging seam: the trace hook's variants and the state snapshot.
 *
 * These are public API through TermDOMOptions, so they are exercised the way
 * an application reaches them -- construct with a hook, drive the session,
 * read the log -- and never through a seam opened for the suite.
 */

import {test, expect, describe} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {transportFromProcess} from "../src/internal/pty.js";
import {byteLength, type TraceEvent} from "../src/internal/trace.js";
import {MockProcess, nextFrame} from "./test-utils.js";

/**
 * A terminal that keeps every byte written to it. stdin.isTTY:false turns
 * cursor detection off, so a session over it is synchronous from attach.
 */
function rawTerminal(
	rows: number,
	cols: number,
): {process: any; written: () => string} {
	let output = "";
	return {
		process: {
			stdout: {
				write: (chunk: any, encoding?: any, callback?: any) => {
					output += chunk;
					if (typeof encoding === "function") {
						callback = encoding;
					}
					if (callback) {
						setImmediate(() => callback());
					}
					return true;
				},
				columns: cols,
				rows,
				isTTY: true,
			},
			stdin: {
				isTTY: false,
				setRawMode: () => {},
				resume: () => {},
				pause: () => {},
				setEncoding: () => {},
				on: () => {},
				off: () => {},
			},
			exit: () => {},
			env: {},
			on: () => {},
			emit: () => false,
			removeListener: () => {},
			removeAllListeners: () => {},
		},
		written: () => output,
	};
}

/** Chrome above and below a nine-row full-width pane, for the band. */
const CHROME_AND_PANE =
	"<div id=\"head\">HEADER</div>" +
	"<div id=\"pane\" style=\"height:9em;overflow-y:scroll\">" +
	Array.from({length: 40}, (_, i) => `<div>row ${i}</div>`).join("") +
	"</div>" +
	"<div id=\"foot\">FOOTER</div>";

/** One line per event, in the shape a log is grepped by. */
function signatures(events: TraceEvent[]): string[] {
	return events.map((event) => {
		switch (event.type) {
			case "lifecycle":
				return `lifecycle:${event.from}>${event.to}`;
			case "frame.skipped":
				return `frame.skipped:${event.reason}`;
			case "mode.engaged":
			case "mode.reset":
				return `${event.type}:${event.mode}`;
			default:
				return event.type;
		}
	});
}

/**
 * The wanted signatures that do not appear in order among `all`. An empty
 * result is the assertion; a non-empty one names what the session never did.
 */
function missingInOrder(all: string[], wanted: string[]): string[] {
	const missing: string[] = [];
	let at = 0;
	for (const want of wanted) {
		const found = all.indexOf(want, at);
		if (found === -1) {
			missing.push(want);
		} else {
			at = found + 1;
		}
	}
	return missing;
}

describe("the trace hook", () => {
	test("reports a scripted session's variants in order", async () => {
		const terminal = rawTerminal(12, 40);
		const events: TraceEvent[] = [];
		const dom = new TermDOM({
			transport: transportFromProcess(terminal.process as any),
			trace: (event) => events.push(event),
		});

		dom.attach();
		dom.document.body.innerHTML = CHROME_AND_PANE;
		await nextFrame(dom);

		dom.document.getElementById("pane")!.scrollTop = 3;
		await nextFrame(dom);

		const stage = dom.document.getElementById("head")!;
		await stage.requestFullscreen();
		await nextFrame(dom);
		await dom.document.exitFullscreen();
		await nextFrame(dom);

		await dom.dispose();

		expect(
			missingInOrder(signatures(events), [
				"lifecycle:detached>attaching",
				"mode.engaged:bracketedPaste",
				"mode.engaged:cursorHidden",
				"mode.engaged:mouseCapture",
				"lifecycle:attaching>attached",
				"frame.repainted",
				"frame.transformed",
				"mode.engaged:altScreen",
				"mode.reset:altScreen",
				"lifecycle:attached>disposed",
				"mode.reset:mouseCapture",
				"mode.reset:bracketedPaste",
			]),
		).toEqual([]);
	});

	test("reports the decoded input items the wire carries", async () => {
		const terminal = new MockProcess({rows: 12, cols: 40});
		const events: TraceEvent[] = [];
		const dom = new TermDOM({
			transport: terminal.transport,
			trace: (event) => events.push(event),
		});
		dom.document.body.innerHTML = "<input id=\"field\">";
		await nextFrame(dom);
		dom.document.getElementById("field")!.focus();

		terminal.stdin.simulateResponse("hi");
		terminal.stdin.simulateResponse("\x1b[<0;5;2M");
		terminal.stdin.simulateResponse("\x1b[200~pasted\x1b[201~");
		await nextFrame(dom);

		const keys = events.find((event) => event.type === "input.keys");
		const mouse = events.find((event) => event.type === "input.mouse");
		const paste = events.find((event) => event.type === "input.paste");
		expect(keys).toEqual({type: "input.keys", keys: "hi"});
		expect(mouse).toEqual({
			type: "input.mouse",
			button: 0,
			x: 5,
			y: 2,
			release: false,
		});
		// The text stays off the event without traceBytes.
		expect(paste).toEqual({type: "input.paste", length: 6});

		await dom.dispose();
	});

	test("byte counts add up to what the transport received", async () => {
		const terminal = rawTerminal(12, 40);
		const events: TraceEvent[] = [];
		const dom = new TermDOM({
			transport: transportFromProcess(terminal.process as any),
			trace: (event) => events.push(event),
		});

		dom.attach();
		dom.document.body.innerHTML = CHROME_AND_PANE;
		await nextFrame(dom);
		dom.document.getElementById("pane")!.scrollTop = 3;
		await nextFrame(dom);
		await dom.dispose();

		const traced = events
			.filter((event) => event.type === "wire.write")
			.reduce((total, event) => total + event.bytes, 0);
		expect(traced).toBe(byteLength(terminal.written()));
	});

	test("traceBytes carries the bytes it counted", async () => {
		const terminal = rawTerminal(12, 40);
		const events: TraceEvent[] = [];
		const dom = new TermDOM({
			transport: transportFromProcess(terminal.process as any),
			trace: (event) => events.push(event),
			traceBytes: true,
		});

		dom.attach();
		dom.document.body.innerHTML = "<div>TRACED</div>";
		await nextFrame(dom);
		await dom.dispose();

		const writes = events.filter((event) => event.type === "wire.write");
		expect(writes.map((write) => write.text).join("")).toBe(
			terminal.written(),
		);
		for (const write of writes) {
			expect(byteLength(write.text!)).toBe(write.bytes);
		}
	});

	test("a throwing hook costs its event and not the frame", async () => {
		const terminal = new MockProcess({rows: 12, cols: 40});
		let calls = 0;
		const dom = new TermDOM({
			transport: terminal.transport,
			trace: () => {
				calls++;
				throw new Error("the hook is broken");
			},
		});

		dom.document.body.innerHTML = "<div>STILL PAINTED</div>";
		await nextFrame(dom);

		expect(calls).toBeGreaterThan(0);
		expect(terminal.getPlainText()).toContain("STILL PAINTED");
		await dom.dispose();
	});
});

describe("snapshot", () => {
	test("agrees with the emulator's grid for a rendered scene", async () => {
		const terminal = new MockProcess({rows: 12, cols: 40});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML =
			"<div>FIRST ROW</div><div>second row</div><div>third row</div>";
		await nextFrame(dom);

		expect(dom.snapshot().screen).toBe(terminal.getPlainText());
		await dom.dispose();
	});

	test("agrees with the emulator after the camera moves", async () => {
		const terminal = new MockProcess({rows: 8, cols: 40});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML = Array.from(
			{length: 30},
			(_, i) => `<div>line ${i}</div>`,
		).join("");
		await nextFrame(dom);

		dom.window.scrollTo(0, 6);
		await nextFrame(dom);

		const snapshot = dom.snapshot();
		expect(snapshot.scrollTop).toBe(6);
		expect(snapshot.screen).toBe(terminal.getPlainText());
		await dom.dispose();
	});

	test("reports the camera, the lifecycle and the engaged modes", async () => {
		const terminal = new MockProcess({rows: 12, cols: 40});
		const dom = new TermDOM({transport: terminal.transport});

		expect(dom.snapshot()).toMatchObject({
			lifecycle: "detached",
			cols: 40,
			rows: 12,
			scrollTop: 0,
			screenTop: 0,
			fullscreenElement: null,
			modes: [],
			screen: "",
		});

		dom.document.body.innerHTML = "<div id=\"stage\">STAGE</div>";
		await nextFrame(dom);
		const stage = dom.document.getElementById("stage")!;
		await stage.requestFullscreen();
		await nextFrame(dom);

		const snapshot = dom.snapshot();
		expect(snapshot.lifecycle).toBe("attached");
		expect(snapshot.fullscreenElement).toBe("DIV#stage");
		expect(snapshot.modes).toContain("altScreen");
		expect(snapshot.modes).toContain("mouseCapture");

		await dom.dispose();
		expect(dom.snapshot().lifecycle).toBe("disposed");
	});
});
