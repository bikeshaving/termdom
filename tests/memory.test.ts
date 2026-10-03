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

// The heap after a forced collection, before and after a churn. A leak
// of a few kilobytes per element is megabytes here, well clear of noise.
async function growth(html: (round: number) => string): Promise<number> {
	const dom = create();
	await mountAndRemove(dom, html(0));
	await settle();
	const before = process.memoryUsage().heapUsed;
	for (let round = 1; round <= 40; round++) {
		await mountAndRemove(dom, html(round));
	}
	await settle();
	const after = process.memoryUsage().heapUsed;
	dom.dispose();
	return (after - before) / 1e6;
}

const MB = 6;

// A control's UA tree parses its own copy of the UA sheet, and removing it
// reparses every sheet. Rule identity followed the parsed rule, so neither
// shared with what came before, and every round left a chain of tables.
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

// A mail client opens each email in a shadow root of its own, whose sheets
// parse anew each time. The tree's own sheet styles its top element, so
// that element keys a new table each time, and every table below it
// hangs from that one. They hung under the host's values, which every
// host like it shares, and stayed after the email closed.
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
		await open();
		await settle();
		const before = process.memoryUsage().heapUsed;
		for (let i = 0; i < 40; i++) {
			await open();
		}
		await settle();
		const grown = (process.memoryUsage().heapUsed - before) / 1e6;
		dom.dispose();
		expect(grown).toBeLessThan(MB);
	},
);
