/**
 * Properties over a generated document, driven by fast-check.
 *
 * A document is built from a generated tree, mutated a step at a time with a
 * frame between each, and then checked against an oracle. Four oracles live
 * here over the one generator: the incremental frame against a frame rendered
 * once from the same final tree, the incremental computed styles against that
 * same fresh render's, the painted cells against the geometry and hit-testing
 * APIs, and a frame against itself across a resize round trip.
 *
 * The scene vocabulary -- the tree, the script, and the two ways of arriving
 * at a frame -- is shared with the wire properties and lives in scenes.ts.
 * Cross-document transfer is `importNode`, never a re-parse: the parser
 * reshapes `<p><li>` and that is not an engine difference.
 *
 * `FC_NUM_RUNS=500` widens the search, `FC_SEED=...` replays one; fast-check
 * prints both the seed and the path to the counterexample on failure.
 */
import {test} from "@b9g/libuild/test";
import fc from "fast-check";

import {
	frameOf,
	play,
	replay,
	type Run,
	runArbitrary,
	type Scene,
	settle,
} from "./scenes.js";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 25);
// A fixed seed by default: the properties run inside `npm test`, where a
// different sample every time is a different verdict every time. The searching
// is done by widening the run or naming another seed.
const SEED = Number(process.env.FC_SEED ?? 1);

const assertOptions = {
	numRuns: NUM_RUNS,
	seed: SEED,
	includeErrorInReport: true,
};

/** Enough of the cascade to catch a stale entry the frame happens to hide. */
const SAMPLED_PROPERTIES = [
	"display",
	"position",
	"color",
	"background-color",
	"width",
	"white-space",
	"font-weight",
	"padding-left",
];

test(
	"an incrementally mutated frame equals a frame rendered once",
	async () => {
		await fc.assert(
			fc.asyncProperty(runArbitrary, async (run: Run) => {
				const live = await play(run);
				const fresh = await replay(live.dom, {
					cols: live.cols,
					rows: live.rows,
				});
				const incremental = frameOf(live.terminal);
				const once = frameOf(fresh.terminal);
				live.dom.dispose();
				fresh.dom.dispose();
				if (incremental !== once) {
					throw new Error(
						`html: ${run.document.html}\n` +
						`script: ${JSON.stringify(run.script)}\n` +
						`--- incremental\n${incremental}\n--- fresh\n${once}`,
					);
				}
			}),
			assertOptions,
		);
	},
	900000,
);

test(
	"computed styles survive mutation as they would a fresh cascade",
	async () => {
		await fc.assert(
			fc.asyncProperty(runArbitrary, async (run: Run) => {
				const live = await play(run);
				const fresh = await replay(live.dom, {
					cols: live.cols,
					rows: live.rows,
				});
				const mutated = [
					live.dom.document.body,
					...(Array.from(
						live.dom.document.body.querySelectorAll("*"),
					) as any[]),
				];
				const rendered = [
					fresh.dom.document.body,
					...(Array.from(
						fresh.dom.document.body.querySelectorAll("*"),
					) as any[]),
				];
				const differences: string[] = [];
				if (mutated.length !== rendered.length) {
					differences.push(
						`${mutated.length} elements against ${rendered.length}`,
					);
				}
				for (let i = 0; i < Math.min(mutated.length, rendered.length); i++) {
					const a = live.dom.window.getComputedStyle(mutated[i]);
					const b = fresh.dom.window.getComputedStyle(rendered[i]);
					for (const property of SAMPLED_PROPERTIES) {
						const one = a.getPropertyValue(property);
						const other = b.getPropertyValue(property);
						if (one !== other) {
							differences.push(
								`${mutated[i].tagName}[${mutated[i].getAttribute("data-f")}] ` +
								`${property}: ${JSON.stringify(one)} against ` +
								`${JSON.stringify(other)}`,
							);
						}
					}
				}
				const tree = live.dom.document.body.innerHTML;
				live.dom.dispose();
				fresh.dom.dispose();
				if (differences.length) {
					throw new Error(
						`html: ${run.document.html}\n` +
						`script: ${JSON.stringify(run.script)}\n` +
						`tree: ${tree}\n${differences.join("\n")}`,
					);
				}
			}),
			assertOptions,
		);
	},
	900000,
);

/** Every text node under the body, in document order. */
function textNodesOf(document: any): any[] {
	const found: any[] = [];
	const walk = (node: any): void => {
		for (const child of Array.from(node.childNodes) as any[]) {
			if (child.nodeType === 3) {
				found.push(child);
			} else if (child.nodeType === 1) {
				walk(child);
			}
		}
	};
	walk(document.body);
	return found;
}

/** Where a string starts on the screen, if it is there exactly once. */
function cellOf(
	frame: string,
	token: string,
): {row: number; col: number} | null {
	const lines = frame.split("\n");
	let found: {row: number; col: number} | null = null;
	for (let row = 0; row < lines.length; row++) {
		for (
			let col = lines[row].indexOf(token);
			col !== -1;
			col = lines[row].indexOf(token, col + 1)
		) {
			if (found) {
				return null;
			}
			found = {row, col};
		}
	}
	return found;
}

test(
	"a painted token is where geometry and hit-testing say it is",
	async () => {
		await fc.assert(
			fc.asyncProperty(runArbitrary, async (run: Run) => {
				const live = await play(run);
				const document = live.dom.document;
				const frame = frameOf(live.terminal);
				const texts = textNodesOf(document);
				const problems: string[] = [];
				for (const token of run.document.tokens) {
					const holders = texts.filter((text) => text.data.includes(token));
					if (holders.length !== 1) {
						continue;
					}
					const text = holders[0];
					const offset = text.data.indexOf(token);
					if (text.data.indexOf(token, offset + 1) !== -1) {
						continue;
					}
					const cell = cellOf(frame, token);
					if (!cell) {
						continue;
					}

					const range = document.createRange();
					range.setStart(text, offset);
					range.setEnd(text, offset + 1);
					const rect = range.getBoundingClientRect();
					if (rect.left !== cell.col || rect.top !== cell.row) {
						problems.push(
							`${token} painted at ${cell.row},${cell.col} ` +
							`but its range reports ${rect.top},${rect.left}`,
						);
					}

					const hit = document.elementFromPoint(cell.col, cell.row);
					const parent = text.parentElement;
					if (
						!hit ||
						!(hit === parent || hit.contains(parent) || parent.contains(hit))
					) {
						problems.push(
							`${token} at ${cell.row},${cell.col} hit-tests to ` +
							`${hit ? hit.tagName + "[" + hit.getAttribute("data-f") + "]" : "null"}, ` +
							`outside <${parent.tagName} data-f="${parent.getAttribute("data-f")}">`,
						);
					}
				}
				const tree = document.body.innerHTML;
				live.dom.dispose();
				if (problems.length) {
					throw new Error(
						`html: ${run.document.html}\n` +
						`script: ${JSON.stringify(run.script)}\n` +
						`tree: ${tree}\n--- frame\n${frame}\n${problems.join("\n")}`,
					);
				}
			}),
			assertOptions,
		);
	},
	900000,
);

/**
 * Resize the terminal the way SIGWINCH does and wait for the redraw the
 * debounce and the cursor query put at the end of it: the frame is settled
 * once it stops changing.
 */
async function resizeTo(
	scene: Scene,
	cols: number,
	rows: number,
): Promise<string> {
	scene.cols = cols;
	scene.rows = rows;
	scene.terminal.resize(cols, rows);
	scene.terminal.emit("SIGWINCH");
	await settle(scene, 40);
	return frameOf(scene.terminal);
}

const sizeArbitrary = fc.record({
	cols: fc.integer({min: 20, max: 60}),
	rows: fc.integer({min: 14, max: 30}),
});

// The frame is repainted in place and commits nothing, so on the way out
// the document is printed whole as command output. What that leaves on the
// screen has to be the frame the terminal was showing, cell for cell,
// colors included.
test("exiting leaves the frame it was showing", async () => {
	await fc.assert(
		fc.asyncProperty(runArbitrary, async (run: Run) => {
			const live = await play(run);
			// Content taller than the terminal scrolls into the scrollback on
			// the way out, and the screen shows its tail.
			if (live.dom.document.body.scrollHeight > live.rows) {
				live.dom.dispose();
				return;
			}
			const before = live.terminal.getStaticANSI();
			await live.dom.dispose();
			const after = live.terminal.getStaticANSI();
			if (after !== before) {
				throw new Error(
					`html: ${run.document.html}\n` +
					`script: ${JSON.stringify(run.script)}\n` +
					`--- showing\n${before}\n--- left behind\n${after}`,
				);
			}
		}),
		assertOptions,
	);
}, 900000);

test("a resize round trip lands back on the frame it left", async () => {
	await fc.assert(
		fc.asyncProperty(
			runArbitrary,
			sizeArbitrary,
			async (run: Run, other: any) => {
				const live = await play(run);
				// The script may have resized under us; the round trip goes out
				// from where it left the terminal and comes back to it.
				const first = {cols: live.cols, rows: live.rows};
				fc.pre(first.cols !== other.cols || first.rows !== other.rows);
				const before = frameOf(live.terminal);
				// Content taller than the terminal scrolls into the scrollback,
				// which a resize cannot bring back and this property has nothing
				// to say about.
				const height = live.dom.document.body.scrollHeight;
				if (height > Math.min(first.rows, other.rows)) {
					live.dom.dispose();
					return;
				}
				await resizeTo(live, other.cols, other.rows);
				const after = await resizeTo(live, first.cols, first.rows);
				live.dom.dispose();
				if (after !== before) {
					throw new Error(
						`html: ${run.document.html}\n` +
						`script: ${JSON.stringify(run.script)}\n` +
						`${first.cols}x${first.rows} -> ${other.cols}x${other.rows} -> back\n` +
						`--- before\n${before}\n--- after\n${after}`,
					);
				}
			},
		),
		assertOptions,
	);
}, 900000);
