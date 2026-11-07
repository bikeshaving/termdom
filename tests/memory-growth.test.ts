/**
 * Mounting and removing elements leaves the heap where it was.
 */
import {expect, test} from "@b9g/libuild/test";

import {collect, growth, MB} from "./memory-utils.js";

// Each control builds a shadow tree that the cascade registers.
(collect === null ? test.skip : test)(
	"mounting and removing form controls does not grow the heap",
	async () => {
		const controls =
			"<progress value=\"3\" max=\"10\"></progress>" +
			"<meter value=\"0.5\"></meter><input value=\"v\"><textarea>t</textarea>";
		expect(await growth(() => controls.repeat(30))).toBeLessThan(MB);
	},
);

// Elements with styles of their own each add a table of shared values
// under their parent's, which outlive the page.
(collect === null ? test.skip : test)(
	"mounting and removing elements with unique inline styles does not grow the heap",
	async () => {
		const html = (round: number) => Array.from({length: 100}, (_, i) =>
			`<p style="color: #${(round * 100 + i).toString(16).padStart(6, "0")}; ` +
					`margin: ${i}px">p</p>`).join("");
		expect(await growth(html)).toBeLessThan(MB);
	},
);
