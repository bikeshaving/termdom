import {expect, test} from "@b9g/libuild/test";

import {createWindow} from "../src/internal/dom.ts";

test("a FormData holds its entries in order and reads them back by name", () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const data = new window.FormData();

	expect(Object.prototype.toString.call(data)).toBe("[object FormData]");
	expect(data.get("a")).toBe(null);
	expect(data.getAll("a")).toEqual([]);
	expect(data.has("a")).toBe(false);

	data.append("a", "1");
	data.append("b", "2");
	data.append("a", "3");
	expect(data.get("a")).toBe("1");
	expect(data.getAll("a")).toEqual(["1", "3"]);
	expect(data.has("b")).toBe(true);
	expect([...data]).toEqual([["a", "1"], ["b", "2"], ["a", "3"]]);
	expect([...data.keys()]).toEqual(["a", "b", "a"]);
	expect([...data.values()]).toEqual(["1", "2", "3"]);
	expect([...data.entries()]).toEqual([...data]);

	const seen: Array<[string, unknown, boolean]> = [];
	data.forEach(function (value, key, parent) {
		seen.push([key, value, parent === data]);
	});
	expect(seen).toEqual([["a", "1", true], ["b", "2", true], ["a", "3", true]]);

	data.set("a", "4");
	expect([...data]).toEqual([["a", "4"], ["b", "2"]]);
	data.set("c", "5");
	expect([...data]).toEqual([["a", "4"], ["b", "2"], ["c", "5"]]);
	data.delete("a");
	expect([...data]).toEqual([["b", "2"], ["c", "5"]]);
	expect(data.has("a")).toBe(false);
});

test("a FormData turns a value into a string and a blob into a file", async () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const data = new window.FormData();

	data.append("n", 12 as unknown as string);
	expect(data.get("n")).toBe("12");

	const blob = new Blob(["hello"], {type: "text/plain"});
	data.append("plain", blob);
	const blobbed = data.get("plain") as File;
	expect(blobbed).toBeInstanceOf(File);
	expect(blobbed.name).toBe("blob");
	expect(blobbed.type).toBe(blob.type);
	expect(await blobbed.text()).toBe("hello");

	data.append("named", new Blob(["hi"]), "note.txt");
	expect((data.get("named") as File).name).toBe("note.txt");

	data.append("file", new File(["x"], "given.txt", {type: "text/plain"}));
	expect((data.get("file") as File).name).toBe("given.txt");

	data.append("renamed", new File(["x"], "given.txt"), "other.txt");
	expect((data.get("renamed") as File).name).toBe("other.txt");

	data.set("only", new Blob(["y"]), "one.txt");
	expect((data.get("only") as File).name).toBe("one.txt");
});

test("a FormData replaces a lone surrogate in a name or a value", () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const data = new window.FormData();

	data.append("na\uD800me", "va\uDC00lue");
	expect([...data]).toEqual([["na�me", "va�lue"]]);
	expect(data.get("na\uD800me")).toBe("va�lue");
	expect(data.has("na�me")).toBe(true);

	data.append("pair", "😀");
	expect(data.get("pair")).toBe("😀");
});

const CONTROLS = `<!DOCTYPE html><body><form id="f">
	<input name="text" value="hi">
	<input name="check" type="checkbox" checked>
	<input name="checkval" type="checkbox" value="yes" checked>
	<input name="unchecked" type="checkbox" checked value="no" disabled>
	<input name="radio" type="radio" value="r" checked>
	<input name="off" value="x" disabled>
	<input value="anonymous">
	<select name="pick"><option value="a" selected>A</option><option value="b">B</option></select>
	<select name="many" multiple><option value="1" selected>1</option><option value="2" selected>2</option><option value="3">3</option></select>
	<textarea name="note">one
two</textarea>
	<input type="hidden" name="_charset_">
	<datalist><input name="inlist" value="no"></datalist>
	<object name="obj"></object>
	<button name="plain" value="v1">a</button>
	<button name="send" value="v2" type="submit">b</button>
	<input name="pixel" type="image">
</form></body>`;

test("an entry list follows the rule for each kind of control", () => {
	const window = createWindow(CONTROLS);
	const form = window.document.getElementById("f") as HTMLFormElement;

	expect([...new window.FormData(form)]).toEqual([
		["text", "hi"],
		["check", "on"],
		["checkval", "yes"],
		["radio", "r"],
		["pick", "a"],
		["many", "1"],
		["many", "2"],
		["note", "one\r\ntwo"],
		["_charset_", "UTF-8"],
	]);
});

test("a dirname sends the control's direction after its value", () => {
	const window = createWindow(
		`<!DOCTYPE html><body><form id="f">
	<input name="a" value="hi" dirname="a.dir">
	<input name="b" value="hi" dirname="b.dir" dir="rtl">
	<textarea name="c" dirname="c.dir" dir="auto">שלום</textarea>
	<input name="d" type="checkbox" checked dirname="d.dir">
	<input name="e" value="x" dirname="">
	</form></body>`,
	);
	const form = window.document.getElementById("f") as HTMLFormElement;

	expect([...new window.FormData(form)]).toEqual([
		["a", "hi"],
		["a.dir", "ltr"],
		["b", "hi"],
		["b.dir", "rtl"],
		["c", "שלום"],
		["c.dir", "rtl"],
		["d", "on"],
		["e", "x"],
	]);
});

test("only the submitting button is in the entry list", () => {
	const window = createWindow(CONTROLS);
	const {document} = window;
	const form = document.getElementById("f") as HTMLFormElement;
	const send = form.querySelector("[name=send]") as HTMLButtonElement;
	const pixel = form.querySelector("[name=pixel]") as HTMLInputElement;

	const sent = [...new window.FormData(form, send)];
	expect(sent).toContainEqual(["send", "v2"]);
	expect(sent.filter(([name]) => name === "plain")).toEqual([]);
	expect(sent.filter(([name]) => name === "pixel.x")).toEqual([]);

	const clicked = [...new window.FormData(form, pixel)];
	expect(clicked.slice(-2)).toEqual([["pixel.x", "0"], ["pixel.y", "0"]]);

	const other = document.createElement("form");
	document.body.append(other);
	expect(() => new window.FormData(other, send)).toThrow(/does not belong/);
	try {
		new window.FormData(other, send);
	} catch (error) {
		expect((error as DOMException).name).toBe("NotFoundError");
	}
	expect(() => new window.FormData(form, form)).toThrow(TypeError);
});

test("a file input with no file sends an empty file", async () => {
	const window = createWindow(
		'<!DOCTYPE html><body><form id="f"><input name="doc" type="file"></form>',
	);
	const form = window.document.getElementById("f") as HTMLFormElement;
	const file = new window.FormData(form).get("doc") as File;

	expect(file).toBeInstanceOf(File);
	expect(file.name).toBe("");
	expect(file.type).toBe("application/octet-stream");
	expect(file.size).toBe(0);
	expect(await file.text()).toBe("");
});

test("a form-associated custom element sends what it set as its value", () => {
	const window =
		createWindow('<!DOCTYPE html><body><form id="f"></form></body>');
	const {document, customElements} = window;

	class Control extends window.HTMLElement {
		declare internals: ElementInternals;
		constructor() {
			super();
			this.internals = this.attachInternals();
		}

		static get formAssociated(): boolean {
			return true;
		}
	}

	customElements.define("x-control", Control);
	const form = document.getElementById("f") as HTMLFormElement;
	form.innerHTML = `<x-control name="one"></x-control>
		<x-control name="two"></x-control>
		<x-control name="three"></x-control>
		<x-control name="four"></x-control>`;
	const [one, two, three, four] =
		[...form.querySelectorAll("x-control")] as Control[];

	one.internals.setFormValue("a string");
	two.internals.setFormValue(new File(["bytes"], "two.txt"));
	const held = new window.FormData();
	held.append("inner", "1");
	held.append("other", "2");
	three.internals.setFormValue(held);
	four.internals.setFormValue(null);

	const entries = [...new window.FormData(form)];
	expect(entries.map(([name]) => name)).toEqual([
		"one",
		"two",
		"inner",
		"other",
	]);
	expect(entries[0][1]).toBe("a string");
	expect((entries[1][1] as File).name).toBe("two.txt");
	expect(entries[2][1]).toBe("1");
	expect(entries[3][1]).toBe("2");

	three.removeAttribute("name");
	expect([...new window.FormData(form)].map(([name]) => name)).toEqual([
		"one",
		"two",
		"inner",
		"other",
	]);
	two.setAttribute("disabled", "");
	expect([...new window.FormData(form)].some(([name]) => name === "two")).toBe(
		false,
	);
});

test("the formdata event carries the entries and a listener can amend them", () => {
	const window = createWindow(
		'<!DOCTYPE html><body><form id="f"><input name="a" value="1">' +
		'<input name="drop" value="2"></form></body>',
	);
	const {document} = window;
	const form = document.getElementById("f") as HTMLFormElement;
	const seen: Array<[string, boolean, boolean, boolean]> = [];

	document.body.addEventListener("formdata", (event) => {
		const data = (event as FormDataEvent).formData;
		seen.push([
			event.type,
			event.bubbles,
			event.cancelable,
			event.target === form,
		]);
		expect(Object.prototype.toString.call(event)).toBe(
			"[object FormDataEvent]",
		);
		expect([...data]).toEqual([["a", "1"], ["drop", "2"]]);
		data.delete("drop");
		data.append("added", "3");
		expect(() => new window.FormData(form)).toThrow(/already building/);
		try {
			new window.FormData(form);
		} catch (error) {
			expect((error as DOMException).name).toBe("InvalidStateError");
		}
	});

	expect([...new window.FormData(form)]).toEqual([["a", "1"], ["added", "3"]]);
	expect(seen).toEqual([["formdata", true, false, true]]);
	expect(() => new window.FormData(form)).not.toThrow();
	expect(() =>
		new window.FormDataEvent("formdata", {} as FormDataEventInit),
	).toThrow(TypeError);
});

test("a FormData is one to code that reached for the runtime's class", () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const data = new window.FormData();
	data.append("a", "1");

	expect(data instanceof window.FormData).toBe(true);
	expect(data instanceof FormData).toBe(true);
	expect(Object.prototype.toString.call(data)).toBe("[object FormData]");
	// The methods are this class's own, over its own entry list.
	expect(data.get("a")).toBe("1");
	data.set("b", "2");
	expect([...data]).toEqual([["a", "1"], ["b", "2"]]);
});

test("a control can report the runtime's FormData as its value", () => {
	const window =
		createWindow('<!DOCTYPE html><body><form id="f"></form></body>');
	const {document, customElements} = window;

	class Control extends window.HTMLElement {
		declare internals: ElementInternals;
		constructor() {
			super();
			this.internals = this.attachInternals();
		}

		static get formAssociated(): boolean {
			return true;
		}
	}

	customElements.define("x-runtime-control", Control);
	const form = document.getElementById("f") as HTMLFormElement;
	form.innerHTML = '<x-runtime-control name="one"></x-runtime-control>';
	const control = form.querySelector("x-runtime-control") as Control;

	const reported = new FormData();
	reported.append("inner", "1");
	reported.append("other", "2");
	control.internals.setFormValue(reported);

	expect([...new window.FormData(form)]).toEqual([
		["inner", "1"],
		["other", "2"],
	]);
});

test("a formdata event takes either class and reads out the entries", () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const reported = new FormData();
	reported.append("a", "1");

	const event = new window.FormDataEvent("formdata", {formData: reported});
	expect([...event.formData]).toEqual([["a", "1"]]);
	expect(event.formData instanceof window.FormData).toBe(true);
	expect(() =>
		new window.FormDataEvent("formdata", {formData: {} as unknown as FormData}),
	).toThrow(TypeError);
});

function submissionWindow(): ReturnType<typeof createWindow> {
	return createWindow(
		'<!DOCTYPE html><body><form id="f"><input name="a" value="1">' +
		'<button id="send" name="send">go</button></form></body>',
	);
}

test("requestSubmit fires submit and then builds the entry list", () => {
	const window = submissionWindow();
	const {document} = window;
	const form = document.getElementById("f") as HTMLFormElement;
	const send = document.getElementById("send") as HTMLButtonElement;
	const order: string[] = [];
	const sent: Array<[string, unknown]> = [];

	form.addEventListener("submit", (event) => {
		order.push("submit");
		expect((event as SubmitEvent).submitter).toBe(send);
	});
	form.addEventListener("formdata", (event) => {
		order.push("formdata");
		const data = (event as FormDataEvent).formData;
		data.append("extra", "2");
		sent.push(...data);
	});

	form.requestSubmit(send);
	expect(order).toEqual(["submit", "formdata"]);
	expect(sent).toEqual([["a", "1"], ["send", ""], ["extra", "2"]]);
});

test("a submit listener can read the entry list the form would send", () => {
	const window = submissionWindow();
	const {document} = window;
	const form = document.getElementById("f") as HTMLFormElement;
	const send = document.getElementById("send") as HTMLButtonElement;
	let read: Array<[string, unknown]> = [];

	form.addEventListener("submit", (event) => {
		read = [...new window.FormData(event.target as HTMLFormElement, send)];
	});
	form.requestSubmit(send);
	expect(read).toEqual([["a", "1"], ["send", ""]]);
});

test("a canceled submit builds no entry list, and submit() fires no submit", () => {
	const window = submissionWindow();
	const {document} = window;
	const form = document.getElementById("f") as HTMLFormElement;
	const order: string[] = [];

	const cancel = (event: Event): void => {
		order.push("submit");
		event.preventDefault();
	};
	form.addEventListener("submit", cancel);
	form.addEventListener("formdata", () => order.push("formdata"));

	form.requestSubmit();
	expect(order).toEqual(["submit"]);

	form.removeEventListener("submit", cancel);
	form.addEventListener("submit", () => order.push("submit"));
	form.submit();
	expect(order).toEqual(["submit", "formdata"]);

	form.remove();
	form.requestSubmit();
	form.submit();
	expect(order).toEqual(["submit", "formdata"]);
});
