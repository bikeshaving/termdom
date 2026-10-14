/**
 * Web IDL's bindings, as a page sees them: each member checks its this
 * and its arguments, lives on the interface the specs put it on, and
 * an interface without a constructor cannot be constructed. The messages
 * are Chrome's.
 */
import {expect, test} from "@b9g/libuild/test";

import {DOM_INTERFACES} from "../src/generated/domidl.ts";
import {TermDOM} from "../src/index.ts";

function setup(): {window: any; document: any} {
	const term = new TermDOM();
	return {window: term.window, document: term.window.document};
}

function message(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return `${(error as Error).name}: ${(error as Error).message}`;
	}
	return "no error";
}

test("a member called on the wrong object is an illegal invocation", () => {
	const {window, document} = setup();
	const div = document.createElement("div");
	const illegal = "TypeError: Illegal invocation";
	expect(
		message(() =>
			window.Element.prototype.getAttribute.call(document, "x")),
	).toBe(illegal);
	expect(
		message(() =>
			window.Node.prototype.appendChild.call({}, div)),
	).toBe(illegal);
	expect(
		message(() =>
			Object.getOwnPropertyDescriptor(
				window.HTMLInputElement.prototype,
				"value",
			)!.get!.call(div)),
	).toBe(illegal);
	expect(
		message(() =>
			Object.getOwnPropertyDescriptor(
				window.CharacterData.prototype,
				"data",
			)!.get!.call(div),
		),
	).toBe(illegal);
	expect(
		message(() =>
			// eslint-disable-next-line no-restricted-globals
			new Proxy(div, {}).appendChild(document.createElement("span"))),
	)
		.toBe(illegal);
	expect(
		message(() =>
			window.Event.prototype.preventDefault.call({})),
	).toBe(illegal);
});

test("an argument of the wrong interface names the operation and the parameter", () => {
	const {window, document} = setup();
	const div = document.createElement("div");
	expect(message(() => div.appendChild({}))).toBe(
		"TypeError: Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
	);
	// eslint-disable-next-line no-restricted-globals
	expect(message(() => div.appendChild(new Proxy(div.cloneNode(), {}))))
		.toBe(
			"TypeError: Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
		);
	expect(message(() => div.dispatchEvent({}))).toBe(
		"TypeError: Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.",
	);
	expect(message(() => window.getComputedStyle({}))).toBe(
		"TypeError: Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.",
	);
	expect(message(() => div.appendChild())).toBe(
		"TypeError: Failed to execute 'appendChild' on 'Node': 1 argument required, but only 0 present.",
	);
	expect(message(() => new window.MutationObserver(1))).toBe(
		"TypeError: Failed to construct 'MutationObserver': parameter 1 is not of type 'Function'.",
	);
	expect(message(() => new window.Event())).toBe(
		"TypeError: Failed to construct 'Event': 1 argument required, but only 0 present.",
	);
	// A nullable parameter takes null, and an optional one can be left out.
	expect(div.contains(null)).toBe(false);
	expect(div.insertBefore(document.createElement("p"), null).localName)
		.toBe("p");
});

test("where a string will do, anything that is not a node becomes one", () => {
	const {document} = setup();
	const div = document.createElement("div");
	// eslint-disable-next-line no-restricted-globals
	div.append(new Proxy(document.createElement("span"), {}), {});
	expect(div.innerHTML).toBe("[object HTMLSpanElement][object Object]");
});

test("an interface without a constructor cannot be constructed", () => {
	const {window} = setup();
	for (const name of ["Node", "Element", "CharacterData", "HTMLDivElement"]) {
		expect(message(() => new window[name]())).toBe(
			`TypeError: Failed to construct '${name}': Illegal constructor`,
		);
	}
	expect(message(() => window.Text())).toBe(
		"TypeError: Failed to construct 'Text': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
	);
	expect(new window.Text("x").data).toBe("x");

	class Sub extends window.Element {}

	expect(message(() => new Sub())).toBe(
		"TypeError: Failed to construct 'Element': Illegal constructor",
	);
});

test("interface objects chain as the interfaces do", () => {
	const {window, document} = setup();
	const div = document.createElement("div");
	expect(Object.getPrototypeOf(window.HTMLElement)).toBe(window.Element);
	expect(Object.getPrototypeOf(window.Element)).toBe(window.Node);
	expect(div.constructor).toBe(window.HTMLDivElement);
	expect(div instanceof window.Node).toBe(true);
	expect(window.Node.ELEMENT_NODE).toBe(1);
	expect(window.Event.length).toBe(1);
});

test("members live on the interface the specs put them on", () => {
	const {window} = setup();
	const own = (name: string, key: string) =>
		Object.hasOwn(window[name].prototype, key);
	expect(own("Node", "nodeType")).toBe(true);
	expect(own("Element", "nodeType")).toBe(false);
	expect(own("Node", "textContent")).toBe(true);
	expect(own("CharacterData", "textContent")).toBe(false);
	expect(own("Element", "clientWidth")).toBe(true);
	expect(own("HTMLElement", "clientWidth")).toBe(false);
	expect(own("UIEvent", "which")).toBe(true);
	expect(own("KeyboardEvent", "which")).toBe(false);
	expect(own("EventTarget", "addEventListener")).toBe(true);
	expect(own("Element", "addEventListener")).toBe(false);
	// Each kind of node still answers for itself.
	const {document} = window;
	expect(document.createTextNode("x").nodeType).toBe(3);
	expect(document.createElement("p").nodeType).toBe(1);
	expect(document.createTextNode("x").textContent).toBe("x");
});

test("unforgeable members are the object's own", () => {
	const {window, document} = setup();
	expect(Reflect.ownKeys(document)).toEqual(["location"]);
	expect(Object.hasOwn(window.Document.prototype, "location")).toBe(false);
	expect(Object.getOwnPropertyDescriptor(document, "location")!.configurable)
		.toBe(false);
});

test("every interface names itself, and a collection with an index iterates", () => {
	const {window, document} = setup();
	expect(Object.prototype.toString.call(document.createElement("div")))
		.toBe("[object HTMLDivElement]");
	expect(window.Path2D.prototype[Symbol.toStringTag]).toBe("Path2D");
	for (const name of [
		"HTMLSelectElement",
		"HTMLFormElement",
		"HTMLOptionsCollection",
		"DOMStringList",
		"NodeList",
		"HTMLCollection",
	]) {
		expect(typeof window[name].prototype[Symbol.iterator]).toBe("function");
	}
	const select = document.createElement("select");
	select.innerHTML = "<option>a</option><option>b</option>";
	expect([...select].map((option: any) => option.text)).toEqual(["a", "b"]);
	expect([...select.options].map((option: any) => option.text))
		.toEqual(["a", "b"]);
});

test("structuredClone refuses a platform object and copies a serializable one", () => {
	const {window, document} = setup();
	expect(message(() => window.structuredClone(document.createElement("div"))))
		.toBe(
			"DataCloneError: Failed to execute 'structuredClone' on 'Window': HTMLDivElement object could not be cloned.",
		);
	expect(
		message(() =>
			window.structuredClone({list: [new window.Event("x")]})),
	).toBe(
		"DataCloneError: Failed to execute 'structuredClone' on 'Window': Event object could not be cloned.",
	);
	const rect = new window.DOMRect(1, 2, 3, 4);
	const copy = window.structuredClone({rect});
	expect(copy.rect).not.toBe(rect);
	expect(copy.rect instanceof window.DOMRect).toBe(true);
	expect([copy.rect.x, copy.rect.y, copy.rect.width, copy.rect.height])
		.toEqual([1, 2, 3, 4]);
	expect(window.structuredClone({a: [1, "b"]})).toEqual({a: [1, "b"]});
});

test("an Illegal invocation carries no cause", () => {
	const {document} = setup();
	try {
		// eslint-disable-next-line no-restricted-globals
		new Proxy(document.createElement("div"), {}).remove();
	} catch (error) {
		expect((error as Error).cause).toBe(undefined);
	}
});

test("no interface a page can reach shows an internal member", () => {
	const {window} = setup();
	const shown: string[] = [];
	for (const name of Object.getOwnPropertyNames(window)) {
		const value = window[name];
		if (typeof value !== "function" || !/^[A-Z]/.test(name)) {
			continue;
		}
		for (const target of [value, value.prototype]) {
			if (target == null) {
				continue;
			}
			for (const key of Object.getOwnPropertyNames(target)) {
				if (key.startsWith("_")) {
					shown.push(`${name}.${key}`);
				}
			}
		}
	}
	expect(shown).toEqual([]);
});

test("no member the specs name starts with an underscore, which internal steps use", () => {
	const named = Object.entries(DOM_INTERFACES).flatMap(([name, idl]) =>
		idl.members.map(([key]) => `${name}.${key}`))
		.filter((member) => member.split(".")[1].startsWith("_"));
	expect(named).toEqual([]);
});
