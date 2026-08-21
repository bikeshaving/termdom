/**
 * Replay, in the two engines themselves, the event traces a Korean IME
 * produces, and read back what the terminal would have put on the wire.
 *
 *   node scripts/verify-ime.ts
 *
 * The traces are the ones the engines are documented to send -- WebKit's from
 * xterm.js#5704, Chromium's from xterm.js#5348 -- dispatched as events on the
 * emulator's own textarea, since an IME cannot be typed at from a script. The
 * events are synthetic; everything that reads them is real, including the
 * engine and the emulator. What is asserted is `onData`, which is the whole
 * of what the page hands its transport.
 */
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import * as esbuild from "esbuild";
import {chromium, webkit, type Browser, type Page} from "playwright";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ORIGIN = "http://ime.test";

/** One dispatched event, as the page's driver understands it. */
type Step =
	| {kind: "keydown"; key: string; keyCode: number; composing?: boolean}
	| {
			kind: "input";
			inputType: string;
			data: string | null;
			value: string;
			composed?: boolean;
	  }
	| {kind: "compositionstart"; value: string}
	| {kind: "compositionupdate"; data: string; value: string}
	| {kind: "compositionend"; data: string; value: string};

interface Trace {
	name: string;
	engine: "webkit" | "blink";
	steps: Step[];
	/** Everything the terminal should have sent, in order, joined. */
	expected: string;
}

/**
 * Korean on WebKit: no composition events at all. The first jamo of a
 * syllable arrives as `insertText` and each further one replaces the whole
 * syllable with `insertReplacementText`, under keydowns that all carry the
 * IME's keyCode 229. The syllable is finished by whatever comes next -- here
 * the next syllable's first jamo, and then Enter.
 */
const WEBKIT_HANGUL: Trace = {
	name: "webkit: 한글 by insertReplacementText",
	engine: "webkit",
	steps: [
		{kind: "keydown", key: "Process", keyCode: 229},
		{kind: "input", inputType: "insertText", data: "ㅎ", value: "ㅎ"},
		{kind: "keydown", key: "Process", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "하", value: "하"},
		{kind: "keydown", key: "Process", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "한", value: "한"},
		{kind: "keydown", key: "Process", keyCode: 229},
		{kind: "input", inputType: "insertText", data: "ㄱ", value: "한ㄱ"},
		{kind: "keydown", key: "Process", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "그", value: "한그"},
		{kind: "keydown", key: "Process", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "글", value: "한글"},
		{kind: "keydown", key: "Enter", keyCode: 13},
	],
	expected: "ㅎ\x7f하\x7f한ㄱ\x7f그\x7f글\r",
};

/**
 * The syllable unbuilt: backspace during a composition takes a jamo back off
 * the syllable, and the wire mirrors the unbuild -- the echoed state comes
 * back with a backspace and the reduced syllable goes down in its place.
 */
const WEBKIT_BACKSPACE: Trace = {
	name: "webkit: backspace unbuilds rather than deletes",
	engine: "webkit",
	steps: [
		{kind: "keydown", key: "Process", keyCode: 229},
		{kind: "input", inputType: "insertText", data: "ㅎ", value: "ㅎ"},
		{kind: "keydown", key: "Process", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "한", value: "한"},
		{kind: "keydown", key: "Backspace", keyCode: 8},
		{kind: "input", inputType: "insertReplacementText", data: "하", value: "하"},
		{kind: "keydown", key: "Enter", keyCode: 13},
	],
	expected: "ㅎ\x7f한\x7f하\r",
};

/**
 * A real composition on the same engine -- a Japanese IME, which WebKit does
 * fire composition events for. The WebKit path has to stand down for it and
 * leave the emulator to send the one thing it composed; two of them sending
 * it is the doubled syllable this is here to catch.
 */
const WEBKIT_COMPOSITION: Trace = {
	name: "webkit: real composition is left to the emulator",
	engine: "webkit",
	steps: [
		{kind: "keydown", key: "Process", keyCode: 229},
		{kind: "compositionstart", value: ""},
		{kind: "compositionupdate", data: "にほん", value: "にほん"},
		{kind: "keydown", key: "Process", keyCode: 229, composing: true},
		{kind: "compositionupdate", data: "日本", value: "日本"},
		{kind: "compositionend", data: "日本", value: "日本"},
	],
	expected: "日本",
};

/**
 * Korean on Chromium: the jamo arrive as ordinary keydowns carrying the
 * keyCodes of the Latin keys they sit on, before any composition has started.
 * Declining them is what lets the composition start; the emulator's own
 * composition path sends the syllable when it ends.
 */
const BLINK_HANGUL: Trace = {
	name: "blink: 한 by declined jamo keydowns",
	engine: "blink",
	steps: [
		{kind: "keydown", key: "ㅎ", keyCode: 71},
		{kind: "compositionstart", value: ""},
		{kind: "compositionupdate", data: "ㅎ", value: "ㅎ"},
		{kind: "keydown", key: "ㅏ", keyCode: 75, composing: true},
		{kind: "compositionupdate", data: "하", value: "하"},
		{kind: "keydown", key: "ㄴ", keyCode: 83, composing: true},
		{kind: "compositionupdate", data: "한", value: "한"},
		{kind: "compositionend", data: "한", value: "한"},
	],
	expected: "한",
};

/**
 * Latin on Chromium, with the handler installed: an ordinary key is none of
 * the handler's business and has to reach the emulator untouched.
 */
const BLINK_LATIN: Trace = {
	name: "blink: an ordinary key is untouched",
	engine: "blink",
	steps: [
		{kind: "keydown", key: "a", keyCode: 65},
		{kind: "input", inputType: "insertText", data: "a", value: "a"},
	],
	expected: "a",
};

/**
 * Recorded from Safari 26 (2026-08-15): events run input-first, with the
 * keyCode-229 keydown AFTER each phase, and the engine re-announces the
 * standing syllable as an IDENTICAL insertReplacementText at every syllable
 * boundary and at commit. Composing 안영 and committing with ! must put
 * each syllable on the wire exactly once.
 */
const WEBKIT_COMMIT_PUNCTUATION: Trace = {
	name: "webkit: punctuation commits without doubling",
	engine: "webkit",
	steps: [
		{kind: "input", inputType: "insertText", data: "ㅇ", value: "ㅇ"},
		{kind: "keydown", key: "ㅇ", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "아", value: "아"},
		{kind: "keydown", key: "ㅏ", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "안", value: "안"},
		{kind: "keydown", key: "ㄴ", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "안", value: "안"},
		{kind: "input", inputType: "insertText", data: "ㅇ", value: "안ㅇ"},
		{kind: "keydown", key: "ㅇ", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "영", value: "안영"},
		{kind: "keydown", key: "ㅕ", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "영", value: "안영"},
		{kind: "keydown", key: "!", keyCode: 49},
		{kind: "keydown", key: "Enter", keyCode: 13},
	],
	expected: "ㅇ\x7f아\x7f안ㅇ\x7f영!\r",
};

/**
 * The same commit typed fast: the terminator's keydown lands BEFORE the
 * identical-replacement re-announcement. The keydown flushes; the
 * re-announcement that follows names a syllable already on the wire.
 */
const WEBKIT_COMMIT_KEYDOWN_FIRST: Trace = {
	name: "webkit: keydown-first punctuation commit",
	engine: "webkit",
	steps: [
		{kind: "input", inputType: "insertText", data: "ㅇ", value: "ㅇ"},
		{kind: "keydown", key: "ㅇ", keyCode: 229},
		{kind: "input", inputType: "insertReplacementText", data: "요", value: "요"},
		{kind: "keydown", key: "ㅛ", keyCode: 229},
		{kind: "keydown", key: "!", keyCode: 49},
		{kind: "input", inputType: "insertReplacementText", data: "요", value: "요"},
	],
	expected: "ㅇ\x7f요!",
};

const TRACES: Trace[] = [
	WEBKIT_HANGUL,
	WEBKIT_BACKSPACE,
	WEBKIT_COMPOSITION,
	BLINK_HANGUL,
	BLINK_LATIN,
	WEBKIT_COMMIT_PUNCTUATION,
	WEBKIT_COMMIT_KEYDOWN_FIRST,
];

/** The page: an emulator, the IME work, and a log of what it sent. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css"></head>
<body style="margin:0"><div id="terminal" style="width:640px;height:320px"></div>
<script type="module">
import {Terminal} from "/xterm.mjs";
import {installIMEQuirks} from "/ime.js";
const terminal = new Terminal({cols: 40, rows: 12});
terminal.open(document.getElementById("terminal"));
const sent = [];
terminal.onData((data) => sent.push(data));
window.harness = {terminal, sent, engine: installIMEQuirks(terminal)};
</script></body></html>`;

/** Dispatch one step. Runs in the page. */
const DRIVE = (step: Step): void => {
	const {terminal} = (window as any).harness;
	const textarea: HTMLTextAreaElement = terminal.textarea;
	const put = (value: string): void => {
		textarea.value = value;
		textarea.selectionStart = textarea.selectionEnd = value.length;
	};
	switch (step.kind) {
		case "keydown": {
			// `keyCode` and `isComposition` are not settable through the event
			// constructors everywhere; both engines let them be defined onto the
			// event, which is what the emulator reads them off of.
			const event = new KeyboardEvent("keydown", {
				key: step.key,
				bubbles: true,
				cancelable: true,
			});
			Object.defineProperty(event, "keyCode", {get: () => step.keyCode});
			Object.defineProperty(event, "isComposing", {
				get: () => step.composing === true,
			});
			textarea.dispatchEvent(event);
			break;
		}
		case "input": {
			put(step.value);
			textarea.dispatchEvent(
				new InputEvent("input", {
					data: step.data,
					inputType: step.inputType,
					bubbles: true,
					cancelable: true,
					composed: step.composed !== false,
				}),
			);
			break;
		}
		case "compositionstart": {
			put(step.value);
			textarea.dispatchEvent(
				new CompositionEvent("compositionstart", {bubbles: true}),
			);
			break;
		}
		case "compositionupdate": {
			put(step.value);
			textarea.dispatchEvent(
				new CompositionEvent("compositionupdate", {
					data: step.data,
					bubbles: true,
				}),
			);
			break;
		}
		case "compositionend": {
			put(step.value);
			textarea.dispatchEvent(
				new CompositionEvent("compositionend", {
					data: step.data,
					bubbles: true,
				}),
			);
			break;
		}
	}
};

async function serve(page: Page): Promise<void> {
	const xterm = await readFile(
		new URL("../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url),
	);
	const css = await readFile(
		new URL("../node_modules/@xterm/xterm/css/xterm.css", import.meta.url),
	);
	const ime = await esbuild.build({
		entryPoints: [`${HERE}../src/clients/ime.ts`],
		bundle: true,
		format: "esm",
		write: false,
	});
	const bodies: Record<string, [string, string | Buffer]> = {
		"/": ["text/html", PAGE],
		"/xterm.mjs": ["text/javascript", xterm],
		"/xterm.css": ["text/css", css],
		"/ime.js": ["text/javascript", ime.outputFiles[0].text],
	};
	await page.route(`${ORIGIN}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const body = bodies[path];
		if (!body) return route.fulfill({status: 404, body: "not found"});
		return route.fulfill({contentType: body[0], body: body[1] as string});
	});
}

async function replay(browser: Browser, trace: Trace): Promise<string> {
	const page = await browser.newPage();
	try {
		await serve(page);
		await page.goto(`${ORIGIN}/`);
		await page.waitForFunction(() => (window as any).harness !== undefined);
		for (const step of trace.steps) {
			await page.evaluate(DRIVE, step);
		}
		// The emulator sends a finished composition from a zero-delay timer, so
		// the wire is only settled a turn after the last event.
		await page.waitForTimeout(50);
		const sent: string[] = await page.evaluate(
			() => (window as any).harness.sent,
		);
		return sent.join("");
	} finally {
		await page.close();
	}
}

function show(text: string): string {
	return JSON.stringify(text);
}

const engines = {
	webkit: {launch: webkit, vendor: "Apple Computer, Inc."},
	blink: {launch: chromium, vendor: "Google Inc."},
} as const;

let failures = 0;
for (const [name, engine] of Object.entries(engines)) {
	const browser = await engine.launch.launch();
	try {
		const page = await browser.newPage();
		await serve(page);
		await page.goto(`${ORIGIN}/`);
		await page.waitForFunction(() => (window as any).harness !== undefined);
		const detected = await page.evaluate(
			() => (window as any).harness.engine,
		);
		await page.close();
		if (detected !== name) {
			failures++;
			console.log(`FAIL ${name}: detected as ${detected}`);
		} else {
			console.log(`ok   ${name}: detected as ${detected}`);
		}
		for (const trace of TRACES.filter((t) => t.engine === name)) {
			const sent = await replay(browser, trace);
			if (sent === trace.expected) {
				console.log(`ok   ${trace.name} -> ${show(sent)}`);
			} else {
				failures++;
				console.log(
					`FAIL ${trace.name}\n       sent     ${show(sent)}\n       expected ${show(trace.expected)}`,
				);
			}
		}
	} finally {
		await browser.close();
	}
}

if (failures > 0) {
	console.log(`\n${failures} failing`);
	process.exit(1);
}
console.log("\nall traces send exactly what was composed");
