export {TermDOM} from "./internal/termdom.js";
export type {
	TermDOMOptions,
	ProcessLike,
	TTYWriteStream,
	TTYReadStream,
} from "./internal/termdom.js";

export {Renderer, generateANSI} from "./internal/ansi.js";
export type {ColorDepth} from "./internal/ansi.js";

export {
	createBuffer,
	Cell,
	type CellBuffer,
	type CellStyle,
} from "./internal/ansi.js";

export {LayoutEngine} from "./internal/layout.js";
export type {RectText} from "./internal/layout.js";

export {
	stringWidth,
	cssColorToNumber as parseColor,
	isBun,
	isDeno,
} from "./internal/runtime.js";
