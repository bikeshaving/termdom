/**
 * A :has() rule whose argument is :focus restyles its subject when the
 * focus moves, whether the subject is above the focused element or a
 * sibling before it.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

test(":has(+ :focus) follows the focus to a later sibling", async () => {
	const terminal = new MockProcess({rows: 6, cols: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<style>.a:has(+ :focus) { color: rgb(255, 0, 0) }</style>" +
		"<div class=\"a\">one</div><div id=\"b\" tabindex=\"0\">bee</div>" +
		"<div id=\"c\" tabindex=\"0\">sea</div>";
	await nextFrame(dom);
	const a = document.querySelector(".a")!;
	const color = () => dom.window.getComputedStyle(a).color;
	expect(color()).not.toBe("rgb(255, 0, 0)");

	document.getElementById("b")!.focus();
	await nextFrame(dom);
	expect(color()).toBe("rgb(255, 0, 0)");
	expect(terminal.getScreenContents()).toContain("\x1b[38;2;255;0;0mone");

	document.getElementById("c")!.focus();
	await nextFrame(dom);
	expect(color()).not.toBe("rgb(255, 0, 0)");
	await dom.dispose();
});

test(":has(:focus) follows the focus into and out of a subtree", async () => {
	const terminal = new MockProcess({rows: 6, cols: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<style>.box:has(:focus) { color: rgb(0, 0, 255) }</style>" +
		"<div class=\"box\">x<div id=\"in\" tabindex=\"0\">in</div></div>" +
		"<div id=\"out\" tabindex=\"0\">out</div>";
	await nextFrame(dom);
	const box = document.querySelector(".box")!;
	document.getElementById("in")!.focus();
	await nextFrame(dom);
	expect(dom.window.getComputedStyle(box).color).toBe("rgb(0, 0, 255)");
	document.getElementById("out")!.focus();
	await nextFrame(dom);
	expect(dom.window.getComputedStyle(box).color).not.toBe("rgb(0, 0, 255)");
	await dom.dispose();
});
