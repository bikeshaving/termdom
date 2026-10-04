/**
 * What a page removes is garbage, as it is in a browser. A mail client
 * mounts each email and removes it when the email closes, so anything the
 * engine keeps per removed element adds up over a day of reading.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {findCollector, MockProcess, nextFrame} from "./test-utils.js";

const collect = await findCollector();

function create(): TermDOM {
	return new TermDOM({
		transport: new MockProcess({cols: 100, rows: 40}).transport,
		cellSize: {width: 8, height: 16},
	});
}

async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		collect!();
	}
}

// The lowest of three readings. What a collection misses only adds, so
// the lowest is the nearest to what is still held.
async function heldHeap(): Promise<number> {
	let lowest = Infinity;
	for (let i = 0; i < 3; i++) {
		await settle();
		lowest = Math.min(lowest, process.memoryUsage().heapUsed);
	}
	return lowest;
}

// Mounted, painted, removed and painted again, in a function of its own:
// what an async function holds across an await, it holds until it returns.
async function mountAndRemove(dom: TermDOM, html: string): Promise<void> {
	const host = dom.document.createElement("div");
	dom.document.body.append(host);
	host.innerHTML = html;
	await nextFrame(dom);
	host.remove();
	await nextFrame(dom);
}

// The cascade keeps the elements it gave a pseudo-element, which every
// link, button and form control gets from the UA sheet.
(collect === null ? test.skip : test)(
	"a removed link and button are collected",
	async () => {
		const dom = create();
		await nextFrame(dom);
		const mount = async () => {
			const host = dom.document.createElement("div");
			dom.document.body.append(host);
			host.innerHTML = "<a href=\"https://example.com/\">link</a><button>go</button>";
			const elements = [
				host.querySelector("a")!,
				host.querySelector("button")!,
			];
			await nextFrame(dom);
			host.remove();
			await nextFrame(dom);
			// Whether a value was collected is only seen through a weak
			// reference, which is the thing under test.
			// eslint-disable-next-line no-restricted-globals
			return elements.map((element) => new WeakRef(element));
		};
		const refs = await mount();
		for (let i = 0; i < 10 && refs.some((ref) => ref.deref()); i++) {
			await settle();
		}
		expect(refs.map((ref) => ref.deref())).toEqual([undefined, undefined]);
		dom.dispose();
	},
);

// Measured from after a warm-up: the first rounds fill caches and compile
// code, which Deno counts as some megabytes of heap that then stay level.
const WARM_UP = 10;

// Each leak these tests were written for held at least 17 MB over 80
// rounds on every runtime, twice what it held over 40. Without them the
// heap wanders by up to 7 MB, more rounds or fewer.
const ROUNDS = 80;
const MB = 12;

// The heap held before and after a churn.
async function growth(html: (round: number) => string): Promise<number> {
	const dom = create();
	for (let round = 0; round < WARM_UP; round++) {
		await mountAndRemove(dom, html(round));
	}
	const before = await heldHeap();
	for (let round = WARM_UP; round < WARM_UP + ROUNDS; round++) {
		await mountAndRemove(dom, html(round));
	}
	const after = await heldHeap();
	dom.dispose();
	return (after - before) / 1e6;
}

// Each control's UA tree parses its own copy of the UA sheet.
(collect === null ? test.skip : test)(
	"mounting and removing form controls does not grow the heap",
	async () => {
		const controls =
			"<progress value=\"3\" max=\"10\"></progress>" +
			"<meter value=\"0.5\"></meter><input value=\"v\"><textarea>t</textarea>";
		expect(await growth(() => controls.repeat(30))).toBeLessThan(MB);
	},
);

// Elements with styles of their own each add a table of shared values
// under their parent's, which outlive the page.
(collect === null ? test.skip : test)(
	"mounting and removing elements with unique inline styles does not grow the heap",
	async () => {
		const html = (round: number) => Array.from({length: 100}, (_, i) =>
			`<p style="color: #${(round * 100 + i).toString(16).padStart(6, "0")}; ` +
					`margin: ${i}px">p</p>`).join("");
		expect(await growth(html)).toBeLessThan(MB);
	},
);

// A mail client opens each email in a shadow root of its own, whose sheet
// styles its top element, so every open keys tables of its own.
(collect === null ? test.skip : test)(
	"opening and closing styled shadow trees does not grow the heap",
	async () => {
		const dom = create();
		const open = async () => {
			const host = dom.document.createElement("mail-view");
			dom.document.body.append(host);
			const root = host.attachShadow({mode: "open"});
			root.innerHTML =
				"<style>div { margin: 0 } p { color: #333 }</style><div>" +
				Array.from(
					{length: 300},
					(_, n) => `<p style="padding: ${n}px"><b>row</b> text</p>`,
				).join("") +
				"</div>";
			await nextFrame(dom);
			host.remove();
			await nextFrame(dom);
		};
		for (let i = 0; i < WARM_UP; i++) {
			await open();
		}
		const before = await heldHeap();
		for (let i = 0; i < ROUNDS; i++) {
			await open();
		}
		const grown = (await heldHeap() - before) / 1e6;
		dom.dispose();
		expect(grown).toBeLessThan(MB);
	},
);
