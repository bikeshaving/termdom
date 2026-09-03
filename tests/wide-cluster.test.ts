import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("a selection boundary inside a cluster takes the cluster whole", async () => {
	const terminal = new MockProcess({cols: 30, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<textarea id=\"t\" cols=\"20\" rows=\"1\"></textarea>";
	const area = dom.document.getElementById("t") as HTMLTextAreaElement;
	area.value = "abकााcd";
	area.focus();
	area.setSelectionRange(3, 6);
	await nextFrame(dom);
	expect(terminal.getPlainText().split("\n")[1]).toContain("abकााcd");
	dom.dispose();
});
