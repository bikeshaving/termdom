import {expect, test} from "@b9g/libuild/test";

import {createDocumentWindow} from "../src/internal/dom.js";

test("a form-associated custom element is disabled by its attribute or a fieldset, and says so", () => {
	const window = createDocumentWindow("<!DOCTYPE html><body></body>");
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
