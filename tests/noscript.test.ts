/**
 * <noscript> follows whether the page's scripts run, which the embedder
 * says with the `scripting` option. Off, the default, its markup is parsed
 * into elements and shown, as in a browser with scripting off. On, it
 * holds text and shows nothing. A policy that lets no script run turns it
 * off whatever the option says.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";

const PAGE =
	"<!DOCTYPE html><html><body><p>page</p>" +
	"<noscript><p id=\"n\">no scripts here</p></noscript></body></html>";

function render(dom: TermDOM): string {
	return dom.renderANSI().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

test("without scripting, a noscript's markup is elements, and shows", () => {
	const dom = new TermDOM({html: PAGE});
	expect(dom.document.getElementById("n")?.localName).toBe("p");
	const text = render(dom);
	expect(text).toContain("no scripts here");
	expect(text).not.toContain("<p");
});

test("with scripting, a noscript holds text and shows nothing", () => {
	const dom = new TermDOM({html: PAGE, scripting: true});
	expect(dom.document.getElementById("n")).toBe(null);
	const text = render(dom);
	expect(text).toContain("page");
	expect(text).not.toContain("no scripts here");
});

test("a policy that lets no script run turns scripting off", () => {
	const dom = new TermDOM({
		html: PAGE,
		scripting: true,
		csp: "script-src 'none'",
	});
	expect(dom.document.getElementById("n")?.localName).toBe("p");
	expect(render(dom)).toContain("no scripts here");
});

test("markup set later parses as its document does", () => {
	const markup = "<noscript><b id=\"m\">later</b></noscript>";
	const off = new TermDOM({html: PAGE});
	off.document.body.innerHTML = markup;
	expect(off.document.getElementById("m")?.localName).toBe("b");
	const on = new TermDOM({html: PAGE, scripting: true});
	on.document.body.innerHTML = markup;
	expect(on.document.getElementById("m")).toBe(null);
	expect(render(on)).not.toContain("later");
});
