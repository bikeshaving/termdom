/**
 * Drawing frames. An iframe's document gets an engine of its own, as the
 * document a TermDOM shows does: a cascade and a layout sized to the
 * iframe's content box, and a painter that paints into cells the iframe
 * then draws as its replaced content. Nothing of it reaches the terminal
 * by itself. It shares the terminal and the cell size of the document the
 * iframe is in, and asks that one for a frame when it changes.
 */
import {Cascade} from "./cssom.ts";
import {
	applyMutations,
	attachDocument,
	constructInternal,
	dispatchAsUserAgent,
	runFrameCallbacks,
	setFrameEngineFactory,
	syncMediaQueries,
	type Window,
} from "./dom.ts";
import {
	adoptCellPixels,
	type Caret,
	CellContext,
	CellGrid,
	clearGrid,
	Framebuffer,
	resize,
} from "./framebuffer.ts";
import {Layout} from "./layout.ts";
import {paint, Painter} from "./painter.ts";
import {getDocumentLoader} from "./resources.ts";
import {_} from "./slots.ts";

setFrameEngineFactory((document, window, parent, changed) => {
	const parentSlots = _(parent).extra;
	const layout = new Layout(window, 0, 0);
	const cascade = new Cascade(window, layout);
	const framebuffer = new Framebuffer(
		0,
		0,
		parentSlots.framebuffer.writer.colorDepth,
	);
	// Painted again only once something in the frame asked for a frame:
	// its own mutations, an animation frame, a load, a resize.
	let stale = true;
	const loader = getDocumentLoader(window);
	attachDocument(document, {
		layout,
		cascade,
		exchange: parentSlots.exchange,
		framebuffer,
		cellSize: parentSlots.cellSize,
		images: parentSlots.images,
		canvas: parentSlots.canvas,
		load: loader === null
			? parentSlots.load
			: (request, context) => loader(document, request, context),
		// A frame's handler attributes stay inert.
		allowsInlineHandler: () => false,
		loadSignal: parentSlots.loadSignal,
		render: () => {
			stale = true;
			changed();
			return Promise.resolve();
		},
		reportUncaught: (error) => parentSlots.reportUncaught(error),
		// A frame's history is its own, and the embedder follows the top's.
		historyChanged: () => {},
		historyTraversed: () => {},
	});
	const painter = new Painter(document, layout, cascade, framebuffer);
	let grid = new CellGrid(0, 0);
	let caret: Caret | null = null;
	return {
		get caret() {
			return caret;
		},
		fit(cols, rows) {
			const cell = parentSlots.framebuffer.cellPixels;
			if (
				framebuffer.cellPixels.width !== cell.width ||
				framebuffer.cellPixels.height !== cell.height
			) {
				adoptCellPixels(framebuffer, cell.width, cell.height);
				stale = true;
			}
			if (cols !== grid.cols || rows !== grid.rows) {
				resizeFrame(framebuffer, layout, cascade, window, cols, rows);
				grid = new CellGrid(rows, cols);
				stale = true;
			}
			runFrameCallbacks(document as unknown as globalThis.Document);
			if (!stale) {
				return grid;
			}
			stale = false;
			applyMutations(document as unknown as globalThis.Document);
			layout.performLayout();
			clearGrid(grid);
			const context = new CellContext(grid, rows, cols, -framebuffer.scrollTop);
			paint(painter, context);
			// The painter puts the caret in document rows. The grid's rows are
			// the viewport's.
			caret = context.caret === null
				? null
				: {...context.caret, row: context.caret.row + context.viewportOffset};
			return grid;
		},
		dispose() {
			stale = false;
		},
	};
});

// A frame resized with its iframe's box, as the document a TermDOM shows
// is with the terminal: a size can flip any @media result and every vw
// and vh, and the frame's window hears resize.
function resizeFrame(
	framebuffer: Framebuffer,
	layout: Layout,
	cascade: Cascade,
	window: Window,
	cols: number,
	rows: number,
): void {
	const changed = cols !== framebuffer.cols || rows !== framebuffer.rows;
	resize(framebuffer, rows, cols);
	layout.resize(cols, rows);
	cascade.syncStylesheets();
	if (changed) {
		dispatchAsUserAgent(
			window as unknown as globalThis.Window,
			constructInternal(() => new window.Event("resize")) as never,
		);
	}
	syncMediaQueries(window.document as unknown as globalThis.Document);
}
