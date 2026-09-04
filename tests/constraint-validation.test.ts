/**
 * Constraint validation on the date-like input types: min, max and step
 * read on each type's own scale.
 */
import {expect, test} from "@b9g/libuild/test";

import {createDocumentWindow} from "../src/internal/dom.ts";

function input(markup: string): HTMLInputElement {
	const window = createDocumentWindow(
		`<!doctype html><html><body>${markup}</body></html>`,
	);
	return window.document.querySelector("input") as HTMLInputElement;
}

test("a date outside its min and max is out of range", () => {
	expect(
		input(
			'<input type=date min="2026-01-10" value="2026-01-05">',
		).validity.rangeUnderflow,
	).toBe(true);
	expect(
		input(
			'<input type=date max="2026-01-10" value="2026-01-15">',
		).validity.rangeOverflow,
	).toBe(true);
	expect(
		input(
			'<input type=date min="2026-01-01" max="2026-01-31" value="2026-01-15">',
		).validity.valid,
	).toBe(true);
});

test("a date off its step is a step mismatch", () => {
	expect(
		input(
			'<input type=date min="2026-01-01" step="7" value="2026-01-08">',
		).validity.stepMismatch,
	).toBe(false);
	expect(
		input(
			'<input type=date min="2026-01-01" step="7" value="2026-01-09">',
		).validity.stepMismatch,
	).toBe(true);
});

test("time steps in seconds and defaults to a minute", () => {
	expect(
		input('<input type=time min="00:00" value="10:30">').validity.stepMismatch,
	).toBe(
		false,
	);
	expect(
		input(
			'<input type=time min="00:00" value="10:30:30">',
		).validity.stepMismatch,
	).toBe(
		true,
	);
	expect(
		input(
			'<input type=time min="00:00" step="30" value="10:30:30">',
		).validity.stepMismatch,
	).toBe(false);
	expect(
		input(
			'<input type=time min="09:00" value="08:00">',
		).validity.rangeUnderflow,
	).toBe(true);
});

test("without a min, the step base is the value attribute", () => {
	expect(
		input('<input type=time value="10:30:30">').validity.stepMismatch,
	).toBe(false);
});

test("month and week step in months and weeks", () => {
	expect(
		input(
			'<input type=month min="2026-01" step="3" value="2026-04">',
		).validity.stepMismatch,
	).toBe(false);
	expect(
		input(
			'<input type=month min="2026-01" step="3" value="2026-03">',
		).validity.stepMismatch,
	).toBe(true);
	expect(
		input(
			'<input type=week min="2026-W02" value="2026-W01">',
		).validity.rangeUnderflow,
	).toBe(true);
	expect(
		input(
			'<input type=week step="2" min="2026-W01" value="2026-W03">',
		).validity.stepMismatch,
	).toBe(false);
});

test("datetime-local compares as a moment", () => {
	expect(
		input('<input type=datetime-local max="2026-01-10T12:00" value="2026-01-10T12:01">').validity.rangeOverflow,
	).toBe(true);
	expect(
		input('<input type=datetime-local max="2026-01-10T12:00" value="2026-01-10T12:00">').validity.valid,
	).toBe(true);
});
