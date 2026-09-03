import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("an on* attribute reflects as a function and fires with the element as this", async () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const {document, window} = dom;
	document.body.innerHTML = "<button id=\"b\" onclick=\"this.dataset.hit = event.type\">go</button>";
	const button = document.getElementById("b") as HTMLButtonElement;
	expect(typeof button.onclick).toBe("function");
	button.click();
	expect(button.dataset.hit).toBe("click");

	button.setAttribute("onclick", "this.dataset.hit = 'again'");
	button.click();
	expect(button.dataset.hit).toBe("again");

	button.removeAttribute("onclick");
	expect(button.onclick).toBe(null);
	button.dataset.hit = "";
	button.click();
	expect(button.dataset.hit).toBe("");

	document.body.setAttribute("onresize", "globalThis.__termdomResized = true");
	expect(typeof window.onresize).toBe("function");
	expect(typeof document.body.onresize).toBe("function");

	const errors: string[] = [];
	window.addEventListener("error", (event) => {
		errors.push((event as ErrorEvent).error?.name);
		event.preventDefault();
	});
	button.setAttribute("onclick", "this is not javascript");
	expect(button.onclick).toBe(null);
	expect(errors).toEqual(["SyntaxError"]);
	await nextFrame(dom);
	dom.dispose();
});
