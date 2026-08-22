/**
 * attach() is the ONLY door to the terminal. Constructing a TermDOM and
 * mutating its document is inert: no stdout bytes, no raw mode, no lazy
 * takeover on first render. attach() takes the terminal and paints whatever
 * the document already holds; mutations after it render normally.
 */
import {test, expect} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils";
import {TermDOM} from "../src/internal/termdom.js";

function countWrites(terminal: MockProcess): {count(): number} {
	let writes = 0;
	const original = terminal.stdout.write.bind(terminal.stdout);
	terminal.stdout.write = ((chunk: any, enc?: any, cb?: any) => {
		writes++;
		return original(chunk, enc, cb);
	}) as typeof terminal.stdout.write;
	return {count: () => writes};
}

test("mutations produce no stdout before attach()", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div>should not paint</div>";
	dom.document.body.appendChild(dom.document.createElement("p"));
	// Let the mutation observer microtask and any stray timers run.
	await new Promise((r) => setTimeout(r, 50));
	expect(writes.count()).toBe(0);
	dom.dispose();
});

test("attach() paints the document built before it", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div>early content</div>";
	await new Promise((r) => setTimeout(r, 20));
	expect(terminal.getVisibleText()).not.toContain("early content");

	dom.attach();
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("early content");
	dom.dispose();
});

test("geometry reads work unattached, and stay silent", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div id=\"box\" style=\"width:10px\">x</div>";
	const rect = dom.document.getElementById("box")!.getBoundingClientRect();
	expect(rect.width).toBe(10);
	expect(writes.count()).toBe(0);
	dom.dispose();
});

test("dispose() before attach() writes nothing", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div>never shown</div>";
	await new Promise((r) => setTimeout(r, 20));
	dom.dispose();
	expect(writes.count()).toBe(0);
});

test("requestFullscreen before attach() rejects and stays silent", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div id=\"stage\">x</div>";
	await expect(
		dom.document.getElementById("stage")!.requestFullscreen(),
	).rejects.toThrow();
	expect(writes.count()).toBe(0);
	dom.dispose();
});

test("renderANSI transforms HTML at the transport's width, touching nothing", () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div>the instance's own document</div>";

	const ansi = dom.renderANSI("<div style=\"color:red\">static content</div>");
	expect(ansi).toContain("static content");
	expect(ansi).toContain("\x1b[38;2;255;0;0m");
	// A document string, not a terminal session: no modes, no cursor control.
	expect(ansi).not.toContain("\x1b[?");
	expect(ansi).not.toContain("\x1b[2J");
	// Styles in the fragment join the cascade.
	expect(
		dom.renderANSI("<style>p { color: #00ff00 }</style><p>green</p>"),
	).toContain("\x1b[38;2;0;255;0m");
	// The instance's document was neither consulted nor mutated, and the
	// transport saw no bytes.
	expect(ansi).not.toContain("the instance's own document");
	expect(dom.document.body.textContent).toBe("the instance's own document");
	expect(writes.count()).toBe(0);
	dom.dispose();
});

test("print() writes the rendered HTML through the transport once", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	await dom.print("<div>printed line</div>");
	expect(writes.count()).toBe(1);
	await new Promise((r) => setTimeout(r, 20));
	expect(terminal.getVisibleText()).toContain("printed line");
	// Ordinary command output: no takeover, and dispose owes nothing more.
	dom.dispose();
	await new Promise((r) => setTimeout(r, 20));
	expect(writes.count()).toBe(1);
});

test("a geometry read never strands the mutations it drained", async () => {
	// scrollIntoView/getBoundingClientRect flush pending mutations for exact
	// layout via takeRecords -- which steals them from the observer callback
	// that would have painted. If no scroll or explicit frame follows, the
	// mutation must still reach the screen: the drain schedules the paint it
	// consumed.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div id=\"a\">before</div>";
	dom.attach();
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("before");

	const el = dom.document.getElementById("a")!;
	el.textContent = "after";
	// The geometry read drains the queue synchronously...
	el.getBoundingClientRect();
	// ...and no rAF, no scroll, no further mutation follows. Wait on wall
	// clock only: the paint must arrive on its own.
	await new Promise((r) => setTimeout(r, 80));
	expect(terminal.getVisibleText()).toContain("after");

	// Two mutate+drain cycles back to back -- keystrokes faster than frames.
	// The screen must catch up to the LAST state, not freeze one behind.
	el.textContent = "second";
	el.getBoundingClientRect();
	el.textContent = "third";
	el.getBoundingClientRect();
	await new Promise((r) => setTimeout(r, 80));
	expect(terminal.getVisibleText()).toContain("third");
	dom.dispose();
});

test("dispose() restores shell-critical modes synchronously", async () => {
	// `term.dispose(); process.exit(0)` is a reasonable app. The engine's own
	// restores ride the transport's write queue and would lose that race, so
	// the process transport restores the modes that wreck a shell -- mouse
	// reporting above all -- synchronously on disengage.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await nextFrame(dom);

	let restored = "";
	const original = terminal.stdout.write.bind(terminal.stdout);
	terminal.stdout.write = ((chunk: any, enc?: any, cb?: any) => {
		restored += String(chunk);
		return original(chunk, enc, cb);
	}) as typeof terminal.stdout.write;

	void dom.dispose();
	// No awaits between dispose and the assertions: exit comes next.
	expect(restored).toContain("\x1b[?1002l");
	expect(restored).toContain("\x1b[?1006l");
	expect(restored).toContain("\x1b[?25h");
	expect(restored).toContain("\x1b[?2004l");
});

test("awaiting dispose() means the final flush has landed", async () => {
	// A CLI that prints a result after teardown (the fuzzy finder's picked
	// line) needs its output BELOW the paid-out document, not raced into it.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	dom.document.body.innerHTML = "<div>document payout line</div>";
	await nextFrame(dom);

	await dom.dispose();
	// The payout has been ingested by the terminal before the promise
	// resolves; a write issued now lands after it.
	expect(terminal.getVisibleText()).toContain("document payout line");
});

test("window.close() before the first frame leaves prior screen content alone", async () => {
	// An immediate close must not pay out at a stale anchor: with no frame
	// ever painted, the payout's cursor moves and erases would land on rows
	// the app never owned -- the shell prompt above.
	const terminal = new MockProcess({cols: 40, rows: 10});
	await new Promise<void>((r) => {
		terminal.stdout.write("PROMPT-LINE\r\n\x1b[5;1H", () => r());
	});
	const shared = terminal.sharedTransport;
	const transport = {
		...shared,
		cols: shared.cols,
		rows: shared.rows,
		close: () => {},
	};
	const dom = new TermDOM({transport});
	dom.attach();
	dom.document.body.innerHTML = "<div>closing content</div>";
	dom.window.close();
	await new Promise((r) => setTimeout(r, 150));

	const text = terminal.getVisibleText();
	expect(text).toContain("PROMPT-LINE");
	expect(text).toContain("closing content");
});

/**
 * A transport that counts the closes it is asked for, which is how a teardown
 * that ran and one a beforeunload listener stopped tell apart.
 */
function closeCountingTransport(terminal: MockProcess): {
	transport: any;
	closes(): number;
} {
	const base = terminal.transport;
	let closes = 0;
	return {
		transport: {
			...base,
			cols: base.cols,
			rows: base.rows,
			close: () => {
				closes++;
			},
		},
		closes: () => closes,
	};
}

test("window.close() fires beforeunload, then tears down", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const watched = closeCountingTransport(terminal);
	const dom = new TermDOM({transport: watched.transport});
	dom.attach();
	dom.document.body.innerHTML = "<div>still here</div>";
	await nextFrame(dom);

	const events: any[] = [];
	dom.window.addEventListener("beforeunload", (event) => events.push(event));
	dom.window.close();
	await new Promise((r) => setTimeout(r, 150));

	expect(events.length).toBe(1);
	expect(events[0].type).toBe("beforeunload");
	expect(events[0].cancelable).toBe(true);
	expect(events[0].returnValue).toBe("");
	expect(watched.closes()).toBe(1);
});

test("a beforeunload listener that preventDefaults keeps the session", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const watched = closeCountingTransport(terminal);
	const dom = new TermDOM({transport: watched.transport});
	dom.attach();
	dom.document.body.innerHTML = "<div>unsaved work</div>";
	await nextFrame(dom);

	let asked = 0;
	const listener = (event: any) => {
		asked++;
		event.preventDefault();
	};
	dom.window.addEventListener("beforeunload", listener);
	dom.window.close();
	await new Promise((r) => setTimeout(r, 150));

	expect(asked).toBe(1);
	expect(watched.closes()).toBe(0);
	// The session is still live: a mutation after the canceled close paints.
	dom.document.body.innerHTML = "<div>saved now</div>";
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("saved now");

	// Closing again asks again -- the app's own dialog said yes this time.
	dom.window.removeEventListener("beforeunload", listener);
	dom.window.close();
	await new Promise((r) => setTimeout(r, 150));
	expect(watched.closes()).toBe(1);
});

test("window.close() drains cursor-report debt before the transport closes", async () => {
	// A frame's width probes ask the terminal where the cursor landed; the
	// replies to the last frame's probes may still be on the wire when the
	// app closes. Teardown consumes them before handing the tty back --
	// otherwise the shell that inherits it reads them as typed input.
	let output = "";
	let closes = 0;
	let pushInput!: (text: string) => void;
	const transport = {
		cols: 40,
		rows: 10,
		colorDepth: "rgb",
		readable: new ReadableStream<string>({
			start(controller) {
				pushInput = (text) => controller.enqueue(text);
			},
		}),
		writable: new WritableStream<string>({
			write(chunk) {
				output += String(chunk);
			},
		}),
		resizes: new ReadableStream({start() {}}),
		sharesScreen: false,
		interactive: true,
		ready: Promise.resolve(),
		closed: new Promise(() => {}),
		close: () => {
			closes++;
		},
	};
	const dom = new TermDOM({transport: transport as never});
	await dom.attach();
	dom.document.body.innerHTML = "<div>\u{1F31E} weather</div>";
	await nextFrame(dom);
	const debt = output.split("\x1b[6n").length - 1;
	expect(debt).toBeGreaterThan(0);

	dom.window.close();
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(closes).toBe(0);

	for (let i = 0; i < debt; i++) {
		pushInput(`\x1b[5;${7 + i}R`);
	}
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(closes).toBe(1);
});

test("a beforeunload returnValue keeps the session", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const watched = closeCountingTransport(terminal);
	const dom = new TermDOM({transport: watched.transport});
	dom.attach();
	dom.document.body.innerHTML = "<div>unsaved work</div>";
	await nextFrame(dom);

	dom.window.addEventListener("beforeunload", (event: any) => {
		event.returnValue = "Are you sure?";
	});
	dom.window.close();
	await new Promise((r) => setTimeout(r, 150));

	expect(watched.closes()).toBe(0);
	await dom.dispose();
});

test("Ctrl-C fires beforeunload, and a listener can keep the session", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const watched = closeCountingTransport(terminal);
	const dom = new TermDOM({transport: watched.transport});
	dom.attach();
	dom.document.body.innerHTML = "<div>unsaved work</div>";
	await nextFrame(dom);

	let asked = 0;
	const listener = (event: any) => {
		asked++;
		event.preventDefault();
	};
	dom.window.addEventListener("beforeunload", listener);
	(terminal.stdin as any).emit("data", Buffer.from("\x03"));
	await new Promise((r) => setTimeout(r, 150));

	expect(asked).toBe(1);
	expect(watched.closes()).toBe(0);

	dom.window.removeEventListener("beforeunload", listener);
	(terminal.stdin as any).emit("data", Buffer.from("\x03"));
	await new Promise((r) => setTimeout(r, 150));
	expect(watched.closes()).toBe(1);
});

test("BeforeUnloadEvent is the interface a browser exposes", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const watched = closeCountingTransport(terminal);
	const dom = new TermDOM({transport: watched.transport});
	dom.attach();
	await nextFrame(dom);

	// The interface declares no constructor: only a teardown makes one.
	expect(() => new (dom.window as any).BeforeUnloadEvent()).toThrow(TypeError);

	let fired: any = null;
	dom.window.addEventListener("beforeunload", (event: any) => {
		fired = event;
		// returnValue is a DOMString, so anything set to it stringifies -- and
		// anything but the empty string cancels.
		event.returnValue = 42;
	});
	dom.window.close();
	await new Promise((r) => setTimeout(r, 150));

	expect(fired).not.toBe(null);
	expect(fired instanceof dom.window.Event).toBe(true);
	expect(Object.prototype.toString.call(fired)).toBe(
		"[object BeforeUnloadEvent]",
	);
	expect(fired.returnValue).toBe("42");
	expect(fired.defaultPrevented).toBe(false);
	expect(watched.closes()).toBe(0);
	await dom.dispose();
});

test("the mode probes are followed by an erase for any echoed final", async () => {
	// A terminal without DECRQM can stop parsing at the $ intermediate and
	// print the trailing p as text. The line erase after the probes makes
	// that echo invisible whatever the terminal did with the requests.
	const terminal = new MockProcess({cols: 40, rows: 10});
	// The sink only records: the assertion is about byte order, and a
	// capture-only stream behaves the same under node and bun.
	let out = "";
	const transport = {
		...terminal.transport,
		writable: new WritableStream<string>({
			write(chunk) {
				out += chunk;
			},
		}),
	};
	const dom = new TermDOM({transport});
	dom.attach();
	await nextFrame(dom);
	const lastProbe = out.lastIndexOf("$p");
	const scrub = out.indexOf("\r\x1b[K", lastProbe);
	expect(lastProbe).toBeGreaterThan(-1);
	expect(scrub).toBeGreaterThan(lastProbe);
	await dom.dispose();
});
