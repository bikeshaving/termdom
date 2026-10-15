import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
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

test("elementFromPoint finds a box an inline-block lays out low on the page", async () => {
	const dom = new TermDOM({
		transport: new MockProcess({cols: 40, rows: 12}).transport,
	});
	const {document} = dom;
	document.body.innerHTML =
		"<div>1</div><div>2</div><div>3</div><div>4</div><div>5</div><div>6</div>" +
		"<span style=\"display: inline-block\"><div id=list>" +
		"<div id=a>first</div><div id=b>second</div></div></span>";
	await nextFrame(dom);
	expect(document.elementFromPoint(1, 6)!.id).toBe("a");
	expect(document.elementFromPoint(1, 7)!.id).toBe("b");
	dom.dispose();
});
