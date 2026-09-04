import "./internal/inspector.ts";

export {TermDOM} from "./internal/termdom.ts";
export type {TermDOMOptions} from "./internal/termdom.ts";
export {transportFromProcess} from "./internal/exchange.ts";
export type {
	ProcessLike,
	TTYReadStream,
	TTYWriteStream,
	TerminalCloseInfo,
	TerminalSize,
	TerminalTransport,
} from "./internal/exchange.ts";
