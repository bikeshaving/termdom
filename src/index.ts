export {TermDOM} from "./internal/termdom.js";
export type {TermDOMOptions, TermDOMSnapshot} from "./internal/termdom.js";
export type {
	Trace,
	TraceEvent,
	TraceLifecycle,
	TraceSkipReason,
} from "./internal/trace.js";
export {transportFromProcess} from "./internal/pty.js";
export type {
	ProcessLike,
	TTYReadStream,
	TTYWriteStream,
} from "./internal/pty.js";
export type {
	TerminalCloseInfo,
	TerminalSize,
	TerminalTransport,
} from "./internal/exchange.js";
