/**
 * What a page removes is garbage, as it is in a browser. A mail client
 * mounts each email and removes it when the email closes, so anything the
 * engine keeps per removed element adds up over a day of reading.
 */
import {expect, test} from "@b9g/libuild/test";

import {collect, create, heldHeap, settle} from "./memory-utils.js";
import {
	COLLECTED_MOUNTS,
	COLLECTED_SURVIVORS,
	countHeld,
	nextFrame,
} from "./test-utils.js";

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
		const mounts: Array<Array<WeakRef<object>>> = [];
		for (let i = 0; i < COLLECTED_MOUNTS; i++) {
			mounts.push(await mount());
		}
		expect(await countHeld(mounts, settle)).toBeLessThanOrEqual(
			COLLECTED_SURVIVORS,
		);
		dom.dispose();
	},
);

// A frame's realm has its own interfaces, and the engine keeps tables by
// class, which a class a frame's page makes is one of. Through that class
// a table would hold the whole realm.
(collect === null ? test.skip : test)(
	"a removed frame's realm is collected, with the classes its page made",
	async () => {
		const dom = create();
		await nextFrame(dom);
		const mount = () => {
			const iframe = dom.document.createElement("iframe");
			iframe.setAttribute("srcdoc", "<p>frame</p>");
			dom.document.body.append(iframe);
			const frame = iframe.contentWindow as any;
			const PageEvent = frame.eval(
				"(class PageEvent extends Event { constructor() { super('page'); } })",
			);
			frame.document.body.append(new PageEvent().type);
			iframe.remove();
			// eslint-disable-next-line no-restricted-globals
			return [new WeakRef(frame), new WeakRef(PageEvent)];
		};
		const mounts = Array.from({length: COLLECTED_MOUNTS}, mount);
		expect(await countHeld(mounts, settle)).toBeLessThanOrEqual(
			COLLECTED_SURVIVORS,
		);
		dom.dispose();
	},
);

// Scrolled boxes are tracked to clamp their offsets and to send
// scrollend, and a box another box's scrolling keeps waiting is still
// a box that was removed.
(collect === null ? test.skip : test)(
	"a removed box that was scrolled is collected while another scrolls",
	async () => {
		const dom = create();
		await dom.attach();
		const scroller = (): HTMLElement => {
			const box = dom.document.createElement("div");
			box.style.cssText = "height: 64px; overflow: auto";
			box.innerHTML = "<p>line</p>".repeat(40);
			dom.document.body.append(box);
			return box;
		};
		const other = scroller();
		const mount = async () => {
			const box = scroller();
			await nextFrame(dom);
			box.scrollTop = 64;
			await nextFrame(dom);
			box.remove();
			await nextFrame(dom);
			// eslint-disable-next-line no-restricted-globals
			return [new WeakRef(box)];
		};
		const mounts: Array<Array<WeakRef<object>>> = [];
		for (let i = 0; i < COLLECTED_MOUNTS; i++) {
			mounts.push(await mount());
		}
		let turns = 0;
		const held = await countHeld(mounts, async () => {
			other.scrollTop = 16 * (turns++ % 2);
			await nextFrame(dom);
			await settle();
		});
		expect(held).toBeLessThanOrEqual(COLLECTED_SURVIVORS);
		dom.dispose();
	},
);

// A range nothing holds can never be read, so the document drops it as a
// browser does, and the mutations after it do not walk it.
(collect === null ? test.skip : test)(
	"ranges dropped by the page are collected",
	async () => {
		const dom = create();
		const {document} = dom;
		document.body.innerHTML = "<p>some text</p>";
		const text = document.querySelector("p")!.firstChild!;
		const makeRanges = () => {
			for (let i = 0; i < 20_000; i++) {
				const range = document.createRange();
				range.setStart(text, 1);
				range.setEnd(text, 4);
			}
		};
		makeRanges();
		const before = await heldHeap();
		for (let round = 0; round < 5; round++) {
			makeRanges();
		}
		await settle();
		// The next mutation of the tree lets go of the collected ones.
		document.body.prepend(document.createElement("i"));
		const grown = (await heldHeap()) - before;
		expect(grown).toBeLessThan(4 * 1024 * 1024);
		dom.dispose();
	},
);
