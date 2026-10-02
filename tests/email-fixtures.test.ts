/**
 * Whole emails, rendered. Each fixture is an anonymized layout from real
 * mail: its text replaced with x's, its links, images and identifiers
 * removed, its tables and styles kept. A targeted test pins one behavior;
 * these catch what several behaviors do together, which is where layout
 * regressions hide.
 *
 * The snapshot is the text as it renders and, under it, each row's
 * background runs, since a wrong background over the right text is a bug
 * the text alone cannot show. Update a snapshot only after reading its
 * diff as a change for the better.
 */
import {readdirSync, readFileSync} from "node:fs";

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {getStringWidth} from "../src/internal/text.ts";
import {MockProcess} from "./test-utils.js";

const FIXTURES = new URL("./fixtures/email/", import.meta.url);

/**
 * What a browser gives mail that the terminal defaults do not: cells without
 * borders unless the table asks for them, and a white page under dark text.
 */
const BASE_STYLE = `
	:where(table:not([border]), table[border="0"])
		> :where(thead, tbody, tfoot) > tr > :where(td, th) {
		border: none;
	}
	:where(html) { background-color: #ffffff; color: #000000; }
`;

/** Plain text, then `row: start-end #rrggbb` for every background run. */
function describeRender(ansi: string): string {
	const rows: string[] = [];
	const runs: string[] = [];
	ansi.split("\n").forEach((line, row) => {
		let text = "";
		let column = 0;
		let background: string | null = null;
		let runStart = 0;
		const close = () => {
			if (background !== null && column > runStart) {
				runs.push(`${row}: ${runStart}-${column} ${background}`);
			}
		};
		for (const part of line.split(/(\x1b\[[0-9;:]*m)/)) {
			const sgr = /^\x1b\[([0-9;:]*)m$/.exec(part);
			if (sgr === null) {
				text += part;
				column += getStringWidth(part);
				continue;
			}
			const codes = sgr[1].split(";");
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i];
				let next: string | null | undefined;
				if (code === "0" || code === "" || code === "49") {
					next = null;
				} else if (code === "48" && codes[i + 1] === "2") {
					next =
						"#" + codes.slice(i + 2, i + 5)
							.map((channel) => Number(channel).toString(16).padStart(2, "0"))
							.join("");
					i += 4;
				} else if (code === "38" && codes[i + 1] === "2") {
					i += 4;
				} else if ((code === "38" || code === "48") && codes[i + 1] === "5") {
					i += 2;
				}
				if (next !== undefined && next !== background) {
					close();
					background = next;
					runStart = column;
				}
			}
		}
		close();
		rows.push(text.trimEnd());
	});
	while (rows.length > 0 && rows[rows.length - 1] === "") {
		rows.pop();
	}
	return [...rows, "", "-- backgrounds --", ...runs].join("\n");
}

const files = readdirSync(FIXTURES)
	.filter((name) => name.endsWith(".html"))
	.sort();

for (const name of files) {
	test(`email fixture: ${name}`, () => {
		const html = readFileSync(new URL(name, FIXTURES), "utf8");
		const dom = new TermDOM({
			transport: new MockProcess({cols: 100, rows: 40}).transport,
			cellSize: {width: 7, height: 15},
		});
		const parsed = new dom.window.DOMParser().parseFromString(
			html,
			"text/html",
		);
		const {document} = dom;
		const base = document.createElement("style");
		base.textContent = BASE_STYLE;
		document.head.append(base);
		for (const style of parsed.querySelectorAll("style")) {
			document.head.append(document.adoptNode(style));
		}
		document.body.style.margin = "0";
		document.body.append(
			...[...parsed.body.childNodes].map((node) => document.adoptNode(node)),
		);
		expect(describeRender(dom.renderANSI())).toMatchSnapshot();
		dom.dispose();
	});
}
