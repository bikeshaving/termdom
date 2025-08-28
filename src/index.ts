// === HTML-to-Terminal API ===
export {TermDOM} from "./core/TermDOM.js";
export type {
	TermDOMOptions,
	ProcessLike,
	TTYWriteStream,
	TTYReadStream,
	TextRect,
} from "./core/TermDOM.js";
export {
	ELEMENT_BOUNDS,
	ELEMENT_RECTS,
	ELEMENT_TEXT_RECTS,
	YOGA_NODE,
} from "./core/TermDOM.js";

// Clean rendering pipeline with new Renderer

// Renderer - Efficient delta rendering without xterm.js
export {Renderer} from "./rendering/Renderer.js";
export type {CellStyle} from "./rendering/Renderer.js";
export {ANSIGenerator} from "./rendering/ANSIGenerator.js";
export type {ColorDepth} from "./rendering/ANSIGenerator.js";

// Cell buffer utilities
export {
	createBuffer,
	createNullCell,
	isCellEmpty,
	getCellChar,
	getCellWidth,
	setCellChar,
	setCellFg,
	setCellBg,
	type Cell,
	type CellBuffer,
} from "./rendering/CellBuffer.js";

// Layout Engine
export {LayoutEngine} from "./layout/LayoutEngine.js";
