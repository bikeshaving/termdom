/**
 * Corners of the DOM's own algorithms: which document an attribute belongs to,
 * what a registry reads off a constructor and when, and which exception a
 * member throws.
 */
import {expect, test} from "@b9g/libuild/test";

import {
	createDocumentWindow,
	type Document,
	HTMLElement,
} from "../src/internal/dom.ts";

// The realm the tests reach constructors through: a window of this DOM
// exposes them, as the platform does.
const realm = createDocumentWindow("<!doctype html>");

// The door a test document comes through. The parser is the one that hands
// a document the realm's custom element registry, as it does the engine's.
function createHTMLDocument(title?: string): Document {
	return new realm.DOMParser().parseFromString(
		title === undefined
			? "<!doctype html>"
			: `<!doctype html><title>${title}</title>`,
		"text/html",
	) as unknown as Document;
}

const customElements = realm.customElements;

test("an attribute joins the document of the element it lands on", () => {
	const document = createHTMLDocument("") as any;
	const other = createHTMLDocument("other") as any;
	const element = document.createElement("p");

	const appended = other.createAttribute("data-first");
	expect(appended.ownerDocument === other).toBe(true);
	element.setAttributeNode(appended);
	expect(appended.ownerDocument === document).toBe(true);

	// And so does the attribute that replaces one already there.
	const replacement = other.createAttribute("data-first");
	replacement.value = "second";
	const displaced = element.setAttributeNode(replacement);
	expect(displaced === appended).toBe(true);
	expect(replacement.ownerDocument === document).toBe(true);
	expect(element.getAttribute("data-first")).toBe("second");

	// The namespaced spelling takes the same path.
	const namespaced = other.createAttributeNS("urn:x", "x:third");
	element.setAttributeNodeNS(namespaced);
	expect(namespaced.ownerDocument === document).toBe(true);
});

test("an unset ARIA element reflection reads back as null", () => {
	const document = createHTMLDocument("") as any;
	const element = document.createElement("p");
	const target = document.createElement("p");
	target.id = "t";
	document.body.append(element, target);

	expect(element.ariaControlsElements).toBe(null);
	expect(element.ariaLabelledByElements).toBe(null);
	expect(element.ariaActiveDescendantElement).toBe(null);

	// An attribute naming nothing findable is still a reflection, and reads
	// back as the empty list rather than as nothing at all.
	element.setAttribute("aria-controls", "nobody");
	expect(element.ariaControlsElements).toEqual([]);

	element.ariaControlsElements = [target];
	expect(element.ariaControlsElements).toEqual([target]);

	// Setting null takes the attribute away, and the answer is null again.
	element.ariaControlsElements = null;
	expect(element.hasAttribute("aria-controls")).toBe(false);
	expect(element.ariaControlsElements).toBe(null);
});

test("getName wants a constructor", () => {
	for (const value of [undefined, null, "foo-bar", 1, {}, []]) {
		expect(() => (customElements as any).getName(value)).toThrow(TypeError);
	}
	expect(customElements.getName(class extends HTMLElement {})).toBe(null);
});

test("define reads prototype once, and only after the name is valid", () => {
	const reads: string[] = [];

	function watched(): typeof HTMLElement {
		// The test observes which keys define() reads; only a trap sees reads.
		// eslint-disable-next-line no-restricted-globals
		return new Proxy(class extends HTMLElement {}, {
			get(target, key, receiver) {
				reads.push(String(key));
				return Reflect.get(target, key, receiver);
			},
		});
	}

	// An invalid name is rejected before the constructor is touched at all.
	expect(() =>
		customElements.define("Invalid Name", watched() as any),
	).toThrow();
	expect(reads).toEqual([]);

	// A valid one reads prototype exactly once, then the two class text controls.
	customElements.define("x-read-once", watched() as any);
	expect(reads).toEqual(["prototype", "disabledFeatures", "formAssociated"]);
});

test("attachInternals refuses with a NotSupportedError", () => {
	const document = createHTMLDocument("") as any;
	const plain = document.createElement("div");
	let thrown: any = null;
	try {
		plain.attachInternals();
	} catch (error) {
		thrown = error;
	}
	expect(thrown?.name).toBe("NotSupportedError");
	expect(thrown instanceof TypeError).toBe(false);
});

test("a window's location takes the document's URL apart", () => {
	const window = createDocumentWindow(
		"<!doctype html>",
		"https://example.com:8443/a/b?q=1#top",
	) as any;
	const location = window.location;
	expect(location.href).toBe("https://example.com:8443/a/b?q=1#top");
	expect(location.protocol).toBe("https:");
	expect(location.host).toBe("example.com:8443");
	expect(location.hostname).toBe("example.com");
	expect(location.port).toBe("8443");
	expect(location.pathname).toBe("/a/b");
	expect(location.search).toBe("?q=1");
	expect(location.hash).toBe("#top");
	expect(location.origin).toBe("https://example.com:8443");
	expect(String(location)).toBe(location.href);

	// One object per window, and the document's is the window's.
	expect(window.location).toBe(location);
	expect(window.document.location).toBe(location as never);

	// A terminal document is nobody's frame.
	expect(location.ancestorOrigins.length).toBe(0);
	expect(location.ancestorOrigins.item(0)).toBe(null);
	expect(location.ancestorOrigins.contains("https://example.com:8443")).toBe(
		false,
	);
});

test("a location will not navigate, and an unmounted document has none", () => {
	const window = createDocumentWindow("<!doctype html>") as any;
	const location = window.location;
	expect(location.href).toBe("about:blank");

	for (const navigate of [
		() => location.reload(),
		() => location.assign("https://example.com/"),
		() => location.replace("https://example.com/"),
		() => (location.href = "https://example.com/"),
		() => (location.pathname = "/elsewhere"),
		() => (location.hash = "#elsewhere"),
	]) {
		let thrown: any = null;
		try {
			navigate();
		} catch (error) {
			thrown = error;
		}
		expect(thrown?.name).toBe("NotSupportedError");
	}

	// A document nobody displays is in no browsing context, so it is nowhere.
	expect(createHTMLDocument().location).toBe(null as never);
});
