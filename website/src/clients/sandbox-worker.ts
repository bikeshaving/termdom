/**
 * The worker a playground program runs in. A worker has no document and
 * no window of its own, so a program that supplies them as globals, the
 * way a program does under Node, finds the same absence here. The page
 * sends one message to start it: the repository's files, the program's
 * URL, and the terminal's size. The terminal itself stays in the page,
 * reached through the bridge.
 */
import {workerTransport} from "./sandbox-bridge.js";
import type {WorkerMessage} from "./sandbox-bridge.js";

interface Init {
	type: "init";
	files: Record<string, string>;
	program: string;
	cols: number;
	rows: number;
}

const scope = globalThis as unknown as {
	__workspaceFiles?: Record<string, string>;
	__mainModuleURL?: string;
	__transport?: unknown;
	__termdom?: {document: {documentElement: {scrollHeight: number} | null}};
	process?: unknown;
};

function describe(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name || "Error"}: ${error.message}`;
	}
	return String(error);
}

function reportError(error: unknown): void {
	self.postMessage(
		{type: "error", message: describe(error)} satisfies WorkerMessage,
	);
}

self.addEventListener("unhandledrejection", (event) => {
	event.preventDefault();
	reportError((event as PromiseRejectionEvent).reason);
});

self.addEventListener("message", (event: MessageEvent) => {
	const message = event.data as Init;
	if (typeof message !== "object" || message === null) return;
	if (message.type !== "init") return;

	// Read by the filesystem module as it loads, before any program.
	scope.__workspaceFiles = message.files;
	// The module about to run is the entry point: the guard a
	// runnable-and-importable example ends with compares itself to argv[1].
	scope.__mainModuleURL = message.program;
	scope.process = {
		argv: ["node", "example.ts"],
		env: {},
		cwd: () => "/workspace/termdom",
		platform: "linux",
		stdin: {isTTY: true},
		stdout: {isTTY: true},
		stderr: {isTTY: true},
	};
	// The last TermDOM the program makes reports its document's height
	// with each frame, so the pane can follow the program.
	scope.__transport = workerTransport(
		self,
		{cols: message.cols, rows: message.rows},
		() => scope.__termdom?.document.documentElement?.scrollHeight ?? null,
	);

	void import(/* @vite-ignore */ message.program).catch(reportError);
});
