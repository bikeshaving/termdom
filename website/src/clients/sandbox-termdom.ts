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

export class TermDOM extends EngineTermDOM {
	constructor(options?: TermDOMOptions) {
		super({
			transport: (globalThis as {__transport?: TermDOMOptions["transport"]})
				.__transport,
			...options,
		});
	}
}
