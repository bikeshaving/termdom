import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

async function paint(style: string): Promise<string> {
	const terminal = new MockProcess({cols: 12, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<div style="width: 6ch; height: 3px; border: 1px solid #00ff00; ${style}">x</div>`;
	await nextFrame(dom);
	const output = terminal.getStaticANSI();
	dom.dispose();
	return output;
}

test("an outline in currentcolor paints in the element's color", async () => {
	const named = await paint("color: #ff0000; outline: 1px solid #ff0000");
	const current = await paint("color: #ff0000; outline: 1px solid");
	const none = await paint("color: #ff0000");
	expect(current).toBe(named);
	expect(current).not.toBe(none);
});
