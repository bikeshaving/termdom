/**
 * A cluster with no width (a soft hyphen, a lone format character) takes
 * no cell. Writing one into a cell sent the static renderer's column walk
 * backwards forever.
 */
import {expect, test} from "@b9g/libuild/test";

import {Screen} from "../src/internal/screen.ts";
import {renderStatic} from "./test-utils.js";

test("a zero-width cluster takes no cell and the line still ends", () => {
	const screen = new Screen(1, 10);
	const output = renderStatic(screen, {rows: 1, lineEnding: "\n"}, (ctx) => {
		ctx.drawText("a­b​c", 0, 0);
	});
	expect(output.replace(/\x1b\[[0-9;]*m/g, "")).toBe("abc\n");
});
