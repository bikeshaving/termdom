// V8's compile cache: the module graph is most of a CLI invocation's
// startup. Namespace access because runtimes with their own cache (Bun)
// do not export it.
import * as nodeModule from "node:module";
try {
	(nodeModule as {enableCompileCache?: () => void}).enableCompileCache?.();
} catch {
	// Nothing to do; the runtime just recompiles.
}

export {TermDOM} from "./internal/termdom.js";
export type {TermDOMOptions} from "./internal/termdom.js";
export {transportFromProcess} from "./internal/terminalsession.js";
export type {
	ProcessLike,
	TerminalCloseInfo,
	TerminalSize,
	TerminalTransport,
	TTYReadStream,
	TTYWriteStream,
} from "./internal/terminalsession.js";
