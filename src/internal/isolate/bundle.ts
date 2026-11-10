/**
 * The frame runtime as one classic script for a bare isolate: the engine,
 * its shims and the frame entry, bundled with nothing left to import. The
 * script evaluates to a function of the host's callbacks, which returns a
 * function of the frame's settings, which returns the frame's dispatcher.
 * A built package carries the script next to its modules, and a checkout
 * bundles it from source on first use.
 */
import {readFile} from "node:fs/promises";

export const HOST_CALLBACKS = [
	"post",
	"log",
	"setTimer",
	"clearTimer",
	"random",
	"scripts",
] as const;

export const FRAME_SCRIPT = "isolate-frame.js";

const ENTRY = new URL("./frame.ts", import.meta.url);

export async function buildFrameScript(): Promise<string> {
	const {build} = await import("esbuild");
	const result = await build({
		entryPoints: [ENTRY.pathname],
		bundle: true,
		write: false,
		format: "iife",
		globalName: "__termdomFrame",
		platform: "neutral",
		mainFields: ["module", "main"],
		target: "es2022",
		legalComments: "none",
		define: {"import.meta.url": "undefined", "import.meta.litest": "undefined"},
		logLevel: "silent",
	});
	return `(function (${HOST_CALLBACKS.join(", ")}) {
"use strict";
${result.outputFiles[0].text}
const frame = __termdomFrame;
return (init) => {
	frame.start({${HOST_CALLBACKS.join(", ")}}, init);
	return (kind, ...args) => {
		switch (kind) {
			case "receive": return frame.receive(args[0]);
			case "timer": return frame.fireTimer(args[0]);
			case "scriptBegin": return frame.scriptBegin(args[0]);
			case "scriptEnd": return frame.scriptEnd(args[0]);
			case "scriptFinished": return frame.scriptFinished(args[0], args[1]);
			case "interactive": return frame.documentInteractive();
			case "loaded": return frame.documentLoaded();
			case "dispose": return frame.dispose();
		}
	};
};
})`;
}

let script: Promise<string> | undefined;

export function loadFrameScript(): Promise<string> {
	script ??= (async () => {
		for (const url of [
			new URL(`./${FRAME_SCRIPT}`, import.meta.url),
			new URL(`../${FRAME_SCRIPT}`, import.meta.url),
		]) {
			try {
				return await readFile(url, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
		}
		return buildFrameScript();
	})();
	return script;
}
