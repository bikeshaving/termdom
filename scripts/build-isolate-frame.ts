/**
 * Writes the isolated frame runtime next to the built modules, so a
 * package loads it without bundling anything at run time.
 *
 *   bun run build
 */
import {writeFile} from "node:fs/promises";

import {
	buildFrameScript,
	FRAME_SCRIPT,
} from "../src/internal/isolate/bundle.ts";

await writeFile(
	new URL(`../dist/${FRAME_SCRIPT}`, import.meta.url),
	await buildFrameScript(),
);
