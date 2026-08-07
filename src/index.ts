// TermDOM apps are CLI invocations: the module graph (jsdom above all) is
// half their startup, and V8's compile cache removes most of it from every
// run after the first. Namespace access, not a named import: runtimes with
// their own cache (Bun) may not export it at all.
import * as nodeModule from "node:module";
try {
	(nodeModule as {enableCompileCache?: () => void}).enableCompileCache?.();
} catch {
	// A runtime that objects still starts; it just recompiles.
}

export {TermDOM} from "./internal/termdom.js";
export type {TermDOMOptions} from "./internal/termdom.js";
export {transportFromProcess} from "./internal/terminalsession.js";
export type {
	TerminalTransport,
	TerminalSize,
	TerminalCloseInfo,
	ProcessLike,
	TTYWriteStream,
	TTYReadStream,
} from "./internal/terminalsession.js";
