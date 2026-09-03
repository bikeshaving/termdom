import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("list items keep their markers with no author list-item rule", async () => {
	const terminal = new MockProcess({cols: 20, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<ul><li>one</li></ul><ul style=\"list-style: square inside\"><li>two</li></ul><div>three</div>";
	await nextFrame(dom);
	const lines = terminal.getPlainText().split("\n");
	expect(lines.find((line) => line.includes("one"))).toMatch(/• one/);
	expect(lines.find((line) => line.includes("two"))).toMatch(/▪ two/);
	expect(lines.find((line) => line.includes("three"))).toBe("three");
	dom.dispose();
});
