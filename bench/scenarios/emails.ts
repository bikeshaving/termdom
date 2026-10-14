import {readdirSync} from "node:fs";

import {benchRoot, measure, readBenchFile, TermDOM} from "../harness.ts";

const directory = "tests/fixtures/email";
const emails = readdirSync(`${benchRoot}${directory}`)
	.filter((name) => name.endsWith(".html"))
	.map((name) => readBenchFile(`${directory}/${name}`));
await measure(
	"emails: parse and render every fixture",
	7,
	() => {
		for (const html of emails) {
			new TermDOM({html}).renderANSI();
		}
	},
	2,
);
