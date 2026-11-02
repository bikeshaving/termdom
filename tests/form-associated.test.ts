import {expect, test} from "@b9g/libuild/test";

import {createWindow} from "../src/internal/window.ts";

test("a form-associated custom element is disabled by its attribute or a fieldset, and says so", () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const {document, customElements} = window;
	const history: boolean[] = [];

	class Control extends window.HTMLElement {
		constructor() {
			super();
			this.attachInternals().setFormValue("value");
		}

		static get formAssociated(): boolean {
			return true;
		}

		formDisabledCallback(disabled: boolean): void {
			history.push(disabled);
		}
	}

	customElements.define("x-control", Control);

	const outer = document.createElement("fieldset");
	outer.innerHTML = "<fieldset><x-control></x-control></fieldset>";
	const middle = outer.firstElementChild as HTMLFieldSetElement;
	const control = outer.querySelector("x-control")!;
	expect(control).toBeInstanceOf(Control);
	expect(control.matches(":enabled")).toBe(true);

	middle.disabled = true;
	expect(control.matches(":disabled")).toBe(true);
	middle.disabled = false;
	control.setAttribute("disabled", "");
	expect(control.matches(":enabled")).toBe(false);
	control.removeAttribute("disabled");
	control.remove();
	outer.disabled = true;
	middle.append(control);
	expect(control.matches(":disabled")).toBe(true);
	expect(history).toEqual([true, false, true, false, true]);
});

test("resetting a form calls a form-associated custom element's formResetCallback", () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const {document, customElements} = window;
	let resets = 0;

	class Control extends window.HTMLElement {
		constructor() {
			super();
			this.attachInternals();
		}

		static get formAssociated(): boolean {
			return true;
		}

		formResetCallback(): void {
			resets++;
		}
	}

	customElements.define("x-control", Control);

	const form = document.createElement("form");
	form.innerHTML = "<input value=\"a\"><x-control></x-control>";
	document.body.append(form);
	const input = form.querySelector("input")!;
	input.value = "b";
	form.reset();
	expect(resets).toBe(1);
	expect(input.value).toBe("a");
});

test("a canceled reset and a custom element that is not form-associated call no formResetCallback", () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const {document, customElements} = window;
	const calls: string[] = [];

	class Control extends window.HTMLElement {
		constructor() {
			super();
			this.attachInternals();
		}

		static get formAssociated(): boolean {
			return true;
		}

		formResetCallback(): void {
			calls.push("associated");
		}
	}

	class Plain extends window.HTMLElement {
		formResetCallback(): void {
			calls.push("plain");
		}
	}

	customElements.define("x-control", Control);
	customElements.define("x-plain", Plain);

	const form = document.createElement("form");
	form.innerHTML = "<x-control></x-control><x-plain></x-plain>";
	document.body.append(form);
	form.addEventListener(
		"reset",
		(event) => event.preventDefault(),
		{once: true},
	);
	form.reset();
	expect(calls).toEqual([]);
	form.reset();
	expect(calls).toEqual(["associated"]);
});
