import {expect, test} from "@b9g/libuild/test";

import {Screen} from "../src/internal/screen.ts";
import {TermDOM} from "../src/internal/termdom.ts";
import {MockProcess, nextFrame, stripControlCodes} from "./test-utils.js";

test("a cell written inside a wide cluster's span is dropped, not emitted", () => {
	const screen = new Screen(2, 12, "rgb");
	const ctx = screen.beginFrame({offset: 0});
	ctx.drawText("काा", 2, 0);
	ctx.drawText("ab", 3, 0);
	ctx.drawText("cd", 6, 0);
	const frame = stripControlCodes(screen.endFrame());
	expect(frame).toContain("काा");
	expect(frame).toContain("cd");
	expect(frame).not.toContain("a");
	expect(frame).not.toContain("b");
});

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
