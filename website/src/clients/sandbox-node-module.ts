/**
 * node:module in the sandbox: `createRequire` serves the CommonJS the
 * examples reach for -- Prism and its language packs. The languages are
 * loaded here, statically, so the loader the registry hands back has
 * nothing left to do.
 */
import Prism from "prismjs";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-python.js";

const REGISTRY: Record<string, unknown> = {
	prismjs: Prism,
	"prismjs/components/index.js": (_languages?: string[]) => {},
};

export function createRequire(_url: string): (spec: string) => unknown {
	return (spec: string) => {
		if (spec in REGISTRY) return REGISTRY[spec];
		throw new Error(`"${spec}" is not in the sandbox's require registry`);
	};
}
