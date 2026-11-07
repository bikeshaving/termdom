/**
 * A mail client's shadow trees leave the heap where it was.
 */
import {expect, test} from "@b9g/libuild/test";

import {
	collect,
	create,
	grownOver,
	heldHeap,
	MB,
	WARM_UP,
} from "./memory-utils.js";
import {nextFrame} from "./test-utils.js";

// A mail client that keeps one shadow root and swaps its sheets and body
// for each email: the old sheets' rules key tables nothing reads again.
(collect === null ? test.skip : test)(
	"swapping the sheets and body of one shadow root does not grow the heap",
	async () => {
		const dom = create();
		const host = dom.document.createElement("mail-view");
		dom.document.body.append(host);
		const root = host.attachShadow({mode: "open"});
		let round = 0;
		const open = async () => {
			const n = round++;
			const style = dom.document.createElement("style");
			style.textContent =
				`div { margin: 0 } .r${n} { padding: 0 } b { font-weight: bold }`;
			const body = dom.document.createElement("div");
			body.innerHTML = Array.from(
				{length: 300},
				(_, i) =>
					`<p class="r${n}" style="color: #${(i % 50).toString(16).padStart(2, "0")}0"><b>row</b> <i>text</i></p>`,
			).join("");
			root.replaceChildren(style, body);
			await nextFrame(dom);
		};
		for (let i = 0; i < WARM_UP; i++) {
			await open();
		}
		const grown = await grownOver(heldHeap, open);
		dom.dispose();
		expect(grown).toBeLessThan(MB);
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
		const grown = await grownOver(heldHeap, open);
		dom.dispose();
		expect(grown).toBeLessThan(MB);
	},
);
