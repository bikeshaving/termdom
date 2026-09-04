/**
 * What `import {TermDOM} from "@b9g/termdom"` resolves to inside a sandbox
 * iframe: the engine itself, with one difference -- a TermDOM constructed
 * without a transport gets the one the workbench put on the sandbox's
 * globalThis, the way a node construction gets the process's tty. Programs
 * run as written; the pane is their terminal.
 */
import {TermDOM as EngineTermDOM} from "../../../src/index.js";
import type {TermDOMOptions} from "../../../src/index.js";

export * from "../../../src/index.js";

interface SandboxGlobals {
	__transport?: TermDOMOptions["transport"];
	__termdom?: EngineTermDOM;
}

/**
 * The last TermDOM the program made is left on globalThis for the pane,
 * which reads its document's height to size itself to what it paints.
 */
export class TermDOM extends EngineTermDOM {
	constructor(options?: TermDOMOptions) {
		const globals = globalThis as SandboxGlobals;
		super({transport: globals.__transport, ...options});
		globals.__termdom = this;
	}
}
