/**
 * innerHTML is a fixpoint after one round trip.
 *
 * Assigning markup and reading it back gives the serialization of what the
 * parser made of it; assigning THAT and reading it back must give the same
 * string. Anything else is a disagreement between the two, and a string that
 * parses into a different tree each time it makes a round trip is the shape
 * mutation XSS is written in.
 *
 * The generator leans on where the two are most likely to disagree: raw-text
 * elements, entities and bare `<`/`&`, attribute quoting, comments full of
 * dashes, tables and auto-closing tags, and foreign content.
 *
 * No rendering here, so `FC_NUM_RUNS` can go much higher than the layout
 * properties'.
 */
import {test} from "@b9g/libuild/test";
import fc from "fast-check";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess} from "../tests/test-utils.js";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 200);
const SEED = Number(process.env.FC_SEED ?? 1);

/** Text that the serializer has to escape, or entities the parser has to read. */
const TEXTS = [
	"a<b",
	"a&b",
	"&amp;",
	"&lt;",
	"&#38;",
	"&AMP",
	"&nbsp;",
	" ",
	"a b",
	"</div",
	"<!notatag>",
	"]]>",
	"\r\n",
];

/** Elements whose content is raw text: no markup, no entities. */
const RAW_TEXT = [
	"<script>a < b && c</script>",
	"<script>var s = '</scr' + 'ipt>';</script>",
	"<style>p::before { content: '<&' }</style>",
	"<textarea>a<b&amp;</textarea>",
	"<textarea>\nfirst</textarea>",
	"<title>a<b</title>",
	"<xmp><p>&amp;</xmp>",
	"<noscript><b>x</b></noscript>",
];

/** Attribute values, where quoting and escaping differ from text. */
const ATTRIBUTES = [
	"<div title=\"a&quot;b\"></div>",
	"<div title='a<b'></div>",
	"<div title=\"a&amp;b\"></div>",
	"<div title=\"a&nbsp;b\"></div>",
	"<div title=\"a'b\"></div>",
	"<div title=unquoted></div>",
	"<div data-x></div>",
	"<div title=\"&\"></div>",
];

const COMMENTS = [
	"<!-- plain -->",
	"<!-- -- -->",
	"<!---->",
	"<!--->",
	"<!--<!-- nested -->",
	"<!--a--!>b",
];

/** Shapes the parser rewrites: auto-closing, foster parenting, foreign content. */
const STRUCTURES = [
	"<p>a<p>b",
	"<ul><li>a<li>b</ul>",
	"<table><tr><td>x</td></tr></table>",
	"<table>stray<tr><td>x</table>",
	"<b><i>x</b>y</i>",
	"<svg><circle r='1'/></svg>",
	"<svg><foreignObject><div>x</div></foreignObject></svg>",
	"<math><mi>x</mi></math>",
	"<select><option>a<option>b</select>",
	"<form><input value='&amp;'></form>",
	"<div/>text",
	"<br/>",
];

const fragmentArbitrary = fc.oneof(
	fc.constantFrom(...TEXTS),
	fc.constantFrom(...RAW_TEXT),
	fc.constantFrom(...ATTRIBUTES),
	fc.constantFrom(...COMMENTS),
	fc.constantFrom(...STRUCTURES),
);

const markupArbitrary = fc.letrec<{markup: string}>((tie) => ({
	markup: fc.oneof(
		{maxDepth: 2, depthIdentifier: "markup"},
		fragmentArbitrary,
		fc
			.tuple(
				fc.constantFrom("div", "span", "p", "table", "td", "svg", "textarea"),
				fc.array(tie("markup"), {maxLength: 3}),
			)
			.map(([tag, inner]) => `<${tag}>${inner.join("")}</${tag}>`),
	),
})).markup;

const documentArbitrary = fc
	.array(markupArbitrary, {minLength: 1, maxLength: 4})
	.map((parts) => parts.join(""));

test("innerHTML reaches a fixpoint after one round trip", async () => {
	// One document per batch of runs: nothing here paints, so the mutation
	// records the engine queues on the way in are never drained, and a
	// document that lives for thousands of parses is a document that holds
	// every node it ever built.
	let dom: any = null;
	let host: any = null;
	let served = 0;
	const fresh = (): void => {
		dom?.dispose();
		const terminal = new MockProcess({cols: 60, rows: 24});
		dom = new TermDOM({transport: terminal.transport}) as any;
		host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
	};
	fresh();
	try {
		await fc.assert(
			fc.asyncProperty(documentArbitrary, async (markup: string) => {
				if (served++ % 50 === 0) {
					fresh();
				}
				host.innerHTML = markup;
				const once = host.innerHTML;
				host.innerHTML = once;
				const twice = host.innerHTML;
				if (once !== twice) {
					throw new Error(
						`markup: ${JSON.stringify(markup)}\n` +
						`once:   ${JSON.stringify(once)}\n` +
						`twice:  ${JSON.stringify(twice)}`,
					);
				}
			}),
			{numRuns: NUM_RUNS, seed: SEED, includeErrorInReport: true},
		);
	} finally {
		dom?.dispose();
	}
}, 900000);
