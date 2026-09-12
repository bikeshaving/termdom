/**
 * Linear Gradient Tests
 *
 * The parser reads `background-image` as css-images-3 §3.1 writes it, and
 * the painter fills a box cell by cell with the gradient's color at each
 * cell. A cell's background is the one thing the painted row cannot report
 * as text, so the rendering tests read colors out of the mock terminal's
 * buffer.
 */

import {expect, test} from "@b9g/libuild/test";

import {parseLinearGradient} from "../src/internal/cssvalues.ts";

test("a gradient's direction is an angle or a side or corner", () => {
	expect(parseLinearGradient("linear-gradient(red, blue)")?.angle).toBe(180);
	expect(parseLinearGradient("linear-gradient(to top, red, blue)")?.angle)
		.toBe(0);
	expect(parseLinearGradient("linear-gradient(to right, red, blue)")?.angle)
		.toBe(90);
	expect(parseLinearGradient("linear-gradient(to left, red, blue)")?.angle)
		.toBe(270);
	expect(parseLinearGradient("linear-gradient(45deg, red, blue)")?.angle)
		.toBe(45);
	expect(parseLinearGradient("linear-gradient(100grad, red, blue)")?.angle)
		.toBe(90);
	expect(parseLinearGradient("linear-gradient(0.25turn, red, blue)")?.angle)
		.toBe(90);
	expect(parseLinearGradient("linear-gradient(-90deg, red, blue)")?.angle)
		.toBe(270);
	expect(parseLinearGradient("linear-gradient(1.5708rad, red, blue)")?.angle)
		.toBeCloseTo(90, 2);
});

test("a corner reads in either word order", () => {
	const one =
		parseLinearGradient("linear-gradient(to bottom right, red, blue)");
	const two =
		parseLinearGradient("linear-gradient(to right bottom, red, blue)");
	expect(one?.angle).toBe(135);
	expect(two?.angle).toBe(135);
	expect(parseLinearGradient("linear-gradient(to top left, red, blue)")?.angle)
		.toBe(315);
	expect(parseLinearGradient("linear-gradient(to left top, red, blue)")?.angle)
		.toBe(315);
});

test("stop positions keep the unit the author wrote", () => {
	const gradient = parseLinearGradient(
		"linear-gradient(to right, red 0%, lime 2ch, blue 100%)",
	);
	expect(gradient?.stops.map((stop) => stop.position)).toEqual([
		{percentage: 0},
		2,
		{percentage: 100},
	]);
});

test("a stop with two positions is two stops of one color", () => {
	const gradient =
		parseLinearGradient("linear-gradient(to right, red 0%, blue 50% 100%)");
	expect(gradient?.stops).toEqual([
		{color: 0xff0000, alpha: 1, position: {percentage: 0}},
		{color: 0x0000ff, alpha: 1, position: {percentage: 50}},
		{color: 0x0000ff, alpha: 1, position: {percentage: 100}},
	]);
});

test("a color hint parses and leaves the stops alone", () => {
	const gradient =
		parseLinearGradient("linear-gradient(to right, red, 20%, blue)");
	expect(gradient?.stops.length).toBe(2);
	expect(gradient?.stops[0].color).toBe(0xff0000);
	expect(gradient?.stops[1].color).toBe(0x0000ff);
});

test("transparent is a stop with no alpha", () => {
	const gradient =
		parseLinearGradient("linear-gradient(to right, red, transparent)");
	expect(gradient?.stops[1].alpha).toBe(0);
});

test("repeating gradients are marked", () => {
	expect(
		parseLinearGradient("repeating-linear-gradient(to right, red 0, blue 2ch)")
			?.repeating,
	).toBe(true);
	expect(parseLinearGradient("linear-gradient(red, blue)")?.repeating)
		.toBe(false);
});

test("only the first image of a list is read", () => {
	expect(parseLinearGradient("linear-gradient(red, blue), url(x.png)"))
		.not.toBe(null);
	expect(parseLinearGradient("url(x.png), linear-gradient(red, blue)"))
		.toBe(null);
});

test("values the grammar rejects parse as null", () => {
	expect(parseLinearGradient("none")).toBe(null);
	expect(parseLinearGradient("url(a.png)")).toBe(null);
	expect(parseLinearGradient("radial-gradient(red, blue)")).toBe(null);
	expect(parseLinearGradient("linear-gradient(red)")).toBe(null);
	expect(parseLinearGradient("linear-gradient(to right, bogus, blue)"))
		.toBe(null);
	expect(parseLinearGradient("linear-gradient(to top bottom, red, blue)"))
		.toBe(null);
	expect(parseLinearGradient("linear-gradient(45, red, blue)")).toBe(null);
	expect(parseLinearGradient("linear-gradient(20%, red, blue)")).toBe(null);
});
