import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

test("elementFromPoint retargets against the tree it is asked from", async () => {
	const dom = new TermDOM({
		transport: new MockProcess({cols: 40, rows: 6}).transport,
	});
	const {document} = dom;
	document.body.innerHTML = "<div id=\"d\">ab<span id=\"s\">text</span>cd</div><div id=\"host\"></div>";
	const host = document.getElementById("host")!;
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<span id=\"inner\">shadow</span>";
	await nextFrame(dom);

	expect(document.elementFromPoint(3, 0)!.id).toBe("s");
	expect(document.elementFromPoint(0, 0)!.id).toBe("d");
	expect(document.elementFromPoint(1, 1)!.id).toBe("host");
	expect(root.elementFromPoint(1, 1)!.id).toBe("inner");
	expect(root.elementFromPoint(3, 0)!.id).toBe("s");
	expect(root.elementsFromPoint(1, 1).map((element) => element.id)).toEqual([
		"inner",
		"host",
		"",
		"",
	]);
	dom.dispose();
});
