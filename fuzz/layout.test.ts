/**
 * Properties over the geometry a document lays out to, driven by fast-check.
 *
 * The frame oracles in document.test.ts compare whole rendered frames, which
 * catches a difference but says little about which rule broke. These ask the
 * geometry directly, and each one states a rule of CSS the engine has to keep
 * whatever document it is handed:
 *
 *   - a box out of flow occupies no space, so the boxes around it lay out as
 *     if it were not in the document at all;
 *   - where such a box lands depends on its containing block, not on how many
 *     boxes sit between the two;
 *   - a pass over an unchanged document changes nothing.
 *
 * The first two are the rules the out-of-flow rework had to preserve, and the
 * shape of the bugs it caused on the way: an absolute box displacing the one
 * after it, and one resolving against the wrong ancestor. The scene
 * vocabulary is shared with the other suites and lives in scenes.ts.
 *
 * `FC_NUM_RUNS=500` widens the search, `FC_SEED=...` replays one.
 */
import {test} from "@b9g/libuild/test";
import fc from "fast-check";
import {expect} from "@b9g/libuild/test";
import {documentArbitrary, makeDOM, settle, type Scene} from "./scenes.js";

type Document = {html: string; tokens: string[]};

/**
 * Each case builds two or three documents and settles each, so the default is
 * small enough to sit inside the per-file timeout with the rest of the suite.
 * FC_NUM_RUNS widens it for a real search.
 */
const RUNS = Number(process.env.FC_NUM_RUNS ?? 8);

/**
 * Pinned, as every other suite here pins it. A property that draws its own
 * seed each run fails on documents nobody can get back: the one that found
 * the aliasing below took a thousand runs to catch again, because the seed
 * it failed on was gone.
 */
const SEED = Number(process.env.FC_SEED ?? 1);

/**
 * Every element's box, by the id the generator gave it -- minus any id that
 * more than one element ended up with.
 *
 * The generator's ids are unique in the markup it writes, and parsing can
 * make them stop being unique: a block inside an inline sends the parser
 * through the adoption agency, which reconstructs the formatting element,
 * ATTRIBUTES AND ALL. `<p><em><div>x</div></em></p>` yields two `em`s
 * carrying one id, one empty in the `p` and one holding the text in the
 * `div`. Keying a map by that id keeps whichever came last, so the two
 * documents below would be compared at different elements and disagree
 * about a box neither of them moved.
 */
function rects(scene: Scene): Map<string, string> {
	const out = new Map<string, string>();
	const aliased = new Set<string>();
	const all = scene.dom.document.querySelectorAll("[data-f]");
	for (const element of Array.from(all) as any[]) {
		const id = element.getAttribute("data-f");
		if (out.has(id)) {
			aliased.add(id);
			continue;
		}
		const r = element.getBoundingClientRect();
		out.set(id, `${r.x},${r.y},${r.width},${r.height}`);
	}
	for (const id of aliased) {
		out.delete(id);
	}
	return out;
}

/** The ids in `scene`, in document order. */
function ids(scene: Scene): string[] {
	return (Array.from(scene.dom.document.querySelectorAll("[data-f]")) as any[])
		.map((element) => element.getAttribute("data-f"));
}

async function build(
	markup: string,
	prepare?: (scene: Scene) => void,
): Promise<Scene> {
	const scene = makeDOM({cols: 40, rows: 40});
	scene.dom.document.body.innerHTML = markup;
	prepare?.(scene);
	await settle(scene);
	return scene;
}

test("a box out of flow lays the others out as if it were not there", async () => {
	await fc.assert(
		fc.asyncProperty(
			documentArbitrary,
			fc.nat(),
			async (document: Document, pick: number) => {
				const markup = document.html;
				const probe = await build(markup);
				const present = ids(probe);
				probe.dom.dispose();
				if (present.length === 0) {
					return;
				}
				const target = present[pick % present.length];
				// `display: contents` is left out because the two documents
				// are not the same question for it, and permanently so.
				// Blockification changes an element's OUTER display type, and
				// contents has none -- it is a <display-box> value like none,
				// so the element generates no principal box and there is
				// nothing for `position: absolute` to position. Taking such an
				// element out of flow therefore changes nothing: it is still
				// replaced by its children, which stay in the flow. Removing
				// it takes those children with it. The engine already gets
				// this right, which is why it dissolves on the computed
				// display -- the one place in this file where that is not the
				// bug it was twice above.
				const skip = await build(markup, (scene) => {
					const element = scene.dom.document.querySelector(
						`[data-f="${target}"]`,
					);
					(scene as unknown as {contents: boolean}).contents =
						element !== null &&
						scene.dom.window
							.getComputedStyle(element)
							.getPropertyValue("display") === "contents";
				});
				const isContents = (skip as unknown as {contents: boolean}).contents;
				skip.dom.dispose();
				if (isContents) {
					return;
				}

				// The box, taken out of flow where it stands...
				const floated = await build(markup, (scene) => {
					const element = scene.dom.document.querySelector(
						`[data-f="${target}"]`,
					);
					element?.setAttribute("style", "position: absolute");
				});
				// ...against the same document with it gone entirely.
				const removed = await build(markup, (scene) => {
					const element = scene.dom.document.querySelector(
						`[data-f="${target}"]`,
					);
					element?.remove();
				});

				const withFloat = rects(floated);
				const withGone = rects(removed);
				// Only the boxes still in flow in both are comparable: the
				// target keeps its descendants in one and takes them with it
				// in the other.
				const differences: string[] = [];
				for (const [id, box] of withGone) {
					const other = withFloat.get(id);
					if (other !== undefined && other !== box) {
						differences.push(`${id}: absolute=${other} removed=${box}`);
					}
				}
				floated.dom.dispose();
				removed.dom.dispose();
				expect(differences).toEqual([]);
			},
		),
		{numRuns: RUNS, seed: SEED, includeErrorInReport: true},
	);
});

test("an absolute box lands by its containing block, not its depth", async () => {
	await fc.assert(
		fc.asyncProperty(
			documentArbitrary,
			fc.array(fc.constantFrom("block", "inline-block", "contents"), {
				maxLength: 3,
			}),
			async (document: Document, wrappers: string[]) => {
				const markup = document.html;
				// The same anchored box, buried under boxes that establish no
				// containing block of their own. Its containing block is the
				// anchor however many there are and whatever they are, so its
				// rect may not move. An inline-block among them is the case
				// that matters most: it lays its content out under a root of
				// its own, so the box has to cross out of that tree to reach
				// the anchor.
				const nest = (inner: string, levels: string[]): string => {
					if (levels.length === 0) {
						return inner;
					}
					const [head, ...rest] = levels;
					const wrapped =
						head === "inline-block" ?
							`<span style="display: inline-block">${inner}</span>` :
							head === "contents" ?
								`<div style="display: contents">${inner}</div>` :
								`<div>${inner}</div>`;
					return nest(wrapped, rest);
				};
				const box =
					"<div data-probe style=\"position: absolute; top: 2ch; left: 3ch\">P</div>";
				const anchored = (levels: string[]): string =>
					`<div style="position: relative">${markup}${nest(box, levels)}</div>`;

				const shallow = await build(anchored([]));
				const deep = await build(anchored(wrappers));
				const at = (scene: Scene): string => {
					const el = scene.dom.document.querySelector("[data-probe]");
					const r = el.getBoundingClientRect();
					return `${r.x},${r.y}`;
				};
				const a = at(shallow);
				const b = at(deep);
				shallow.dom.dispose();
				deep.dom.dispose();
				expect(b).toBe(a);
			},
		),
		{numRuns: RUNS, seed: SEED, includeErrorInReport: true},
	);
});

test("laying out an unchanged document again moves nothing", async () => {
	await fc.assert(
		fc.asyncProperty(documentArbitrary, async (document: Document) => {
			const markup = document.html;
			const scene = await build(markup);
			const before = rects(scene);
			// A frame with no mutation between: anything that differs is state
			// one pass left behind for the next.
			await settle(scene);
			const after = rects(scene);
			scene.dom.dispose();
			expect([...after.entries()]).toEqual([...before.entries()]);
		}),
		{numRuns: RUNS, seed: SEED, includeErrorInReport: true},
	);
});
