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
export {Renderer, generateANSI} from "./rendering/Renderer.js";
export type {ColorDepth} from "./rendering/Renderer.js";

// Cell buffer utilities
export {
	createBuffer,
	Cell,
	type CellBuffer,
	type CellStyle,
} from "./rendering/CellBuffer.js";

// Layout Engine
export {LayoutEngine} from "./layout/LayoutEngine.js";
