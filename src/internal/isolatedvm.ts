/**
 * Frames in isolates of their own, made with isolated-vm. Each frame
 * gets an isolate with a memory limit and a context running the frame
 * runtime, and every call into it is held to a time limit. The backend
 * drives the frame's timers, randomness and logs, and fetches, compiles
 * and runs its scripts and modules in document order. Anything the frame
 * fetches, its scripts included, goes to the page, which loads it under
 * its own policy.
 */
import {randomFillSync} from "node:crypto";

import type ivm from "isolated-vm";

import {HOST_CALLBACKS, loadFrameScript} from "./isolate/bundle.ts";
import type {
	FrameInit,
	FrameMessage,
	FrameRequest,
	FrameResponse,
	HostMessage,
} from "./isolate/host.ts";
import type {ScriptItem} from "./isolate/scripts.ts";
import {ModuleLoader} from "./isolatedvmmodules.ts";

export const DEFAULT_MEMORY_LIMIT = 256;
export const DEFAULT_TASK_TIMEOUT = 30000;
const BOOT_TIMEOUT = 10000;
const MAX_RANDOM_BYTES = 65536;
const MAX_TIMERS = 10000;
const MAX_SCRIPTS = 1000;
const MAX_LOG_LENGTH = 4096;

export interface IsolatedFrame {
	send(message: HostMessage): void;
	dispose(): void;
}

export type FrameIsolator = (
	init: FrameInit,
	receive: (message: FrameMessage) => void,
) => IsolatedFrame;

export interface IsolatedVMOptions {
	// Megabytes of heap each frame's isolate may use.
	memoryLimit?: number;
	// Milliseconds any one call into a frame may run.
	taskTimeout?: number;
	// Where a frame's console output and uncaught errors go.
	log?(level: string, text: string): void;
}

type Dispatch = ivm.Reference<(kind: string, ...args: unknown[]) => unknown>;

/**
 * Resolves to the isolator, once isolated-vm has loaded and the frame
 * runtime is compiled. Rejects where isolated-vm is not installed.
 */
export async function createIsolatedVMFrames(
	options: IsolatedVMOptions = {},
): Promise<FrameIsolator> {
	const {default: ivmModule} = await import("isolated-vm");
	const source = await loadFrameScript();
	const memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
	const taskTimeout = options.taskTimeout ?? DEFAULT_TASK_TIMEOUT;
	const log = options.log ?? (() => {});
	let cachedData: ivm.ExternalCopy<ArrayBuffer> | undefined;
	return (init, receive) => {
		const frame = new IsolatedVMFrame(
			ivmModule,
			{memoryLimit, taskTimeout, log},
			init,
			receive,
		);
		void frame.boot(source, cachedData).then((data) => {
			cachedData ??= data;
		});
		return {
			send: (message) => frame.send(message),
			dispose: () => frame.dispose(),
		};
	};
}

class IsolatedVMFrame {
	readonly ivm: typeof ivm;
	readonly isolate: ivm.Isolate;
	readonly init: FrameInit;
	readonly receive: (message: FrameMessage) => void;
	readonly taskTimeout: number;
	readonly log: (level: string, text: string) => void;
	readonly modules: ModuleLoader;
	readonly timers: Map<number, ReturnType<typeof setTimeout>>;
	readonly ownLoads: Map<
		number,
		{resolve(response: FrameResponse): void; reject(error: Error): void}
	>;

	context!: ivm.Context;
	dispatch: Dispatch | null;
	queued: Array<[string, ...unknown[]]> | null;
	nextOwnLoad: number;
	scriptQueue: Promise<void>;
	asyncScripts: Set<Promise<void>>;
	executing: Promise<void>;
	scriptCount: number;
	disposed: boolean;

	constructor(
		ivmModule: typeof ivm,
		limits: {
			memoryLimit: number;
			taskTimeout: number;
			log(level: string, text: string): void;
		},
		init: FrameInit,
		receive: (message: FrameMessage) => void,
	) {
		this.ivm = ivmModule;
		this.init = init;
		this.receive = receive;
		this.taskTimeout = limits.taskTimeout;
		this.log = (level, text) =>
			limits.log(String(level), String(text).slice(0, MAX_LOG_LENGTH));
		this.timers = new Map();
		this.ownLoads = new Map();
		this.dispatch = null;
		this.queued = [];
		this.nextOwnLoad = -1;
		this.scriptQueue = Promise.resolve();
		this.asyncScripts = new Set();
		this.executing = Promise.resolve();
		this.scriptCount = 0;
		this.disposed = false;
		this.isolate = new ivmModule.Isolate({
			memoryLimit: limits.memoryLimit,
			importModuleDynamically: (specifier, referrer) =>
				this.modules.import(String(specifier), String(referrer)),
			onUnhandledRejection: (error) => {
				this.log("error", `Unhandled rejection: ${String(error)}`);
			},
		});
		this.modules = new ModuleLoader({
			isolate: this.isolate,
			context: () => this.context,
			baseURL: () => init.url,
			timeout: () => this.taskTimeout,
			fetch: (request) => this.fetchThroughPage(request),
		});
	}

	async boot(
		source: string,
		cachedData: ivm.ExternalCopy<ArrayBuffer> | undefined,
	): Promise<ivm.ExternalCopy<ArrayBuffer> | undefined> {
		const ivmModule = this.ivm;
		try {
			const script: ivm.Script & ivm.CachedDataResult =
				await this.isolate.compileScript(
					source,
					{
						filename: "termdom:frame",
						...(cachedData ? {cachedData} : {produceCachedData: true}),
					},
				);
			this.context = await this.isolate.createContext();
			const boot = (await script.run(this.context, {
				reference: true,
			})) as unknown as ivm.Reference<
				(...args: unknown[]) => unknown
			>;
			const callbacks: Record<(typeof HOST_CALLBACKS)[number], unknown> = {
				post: new ivmModule.Callback(
					(message: FrameMessage) => this.onPost(message),
					{ignored: true},
				),
				log: new ivmModule.Callback(
					(level: string, text: string) => this.log(level, text),
					{ignored: true},
				),
				setTimer: new ivmModule.Callback(
					(id: number, ms: number) => this.setTimer(id, ms),
					{ignored: true},
				),
				clearTimer: new ivmModule.Callback(
					(id: number) => this.clearTimer(id),
					{ignored: true},
				),
				random: new ivmModule.Callback((length: number) => this.random(length)),
				scripts: new ivmModule.Callback(
					(initial: boolean, items: ScriptItem[]) =>
						this.runScripts(items, initial),
					{ignored: true},
				),
			};
			const starter = (await boot.apply(
				undefined,
				HOST_CALLBACKS.map((name) => callbacks[name]) as ivm.Transferable[],
				{timeout: BOOT_TIMEOUT, result: {reference: true}},
			)) as ivm.Reference<(init: FrameInit) => unknown>;
			boot.release();
			this.dispatch = (await starter.apply(
				undefined,
				[this.init],
				{
					arguments: {copy: true},
					timeout: this.taskTimeout,
					result: {reference: true},
				},
			)) as Dispatch;
			starter.release();
			const queued = this.queued ?? [];
			this.queued = null;
			for (const args of queued) {
				void this.call(...args);
			}
			return script.cachedData;
		} catch (error) {
			this.fail(error);
			return undefined;
		}
	}

	call(kind: string, ...args: unknown[]): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		if (this.queued !== null || this.dispatch === null) {
			this.queued?.push([kind, ...args]);
			return Promise.resolve();
		}
		return this.dispatch
			.apply(
				undefined,
				[kind, ...args],
				{arguments: {copy: true}, timeout: this.taskTimeout},
			)
			.then(() => {}, (error: unknown) => this.fail(error));
	}

	send(message: HostMessage): void {
		if (
			(message.type === "response" || message.type === "fetchError") &&
			message.id < 0
		) {
			const own = this.ownLoads.get(message.id);
			this.ownLoads.delete(message.id);
			if (message.type === "response") {
				own?.resolve(message.response);
			} else {
				own?.reject(new TypeError(`Failed to fetch: ${message.message}`));
			}
			return;
		}
		void this.call("receive", message);
	}

	onPost(message: FrameMessage): void {
		if (this.disposed) {
			return;
		}
		if (
			(message.type === "fetch" || message.type === "abortFetch") &&
			!(message.id > 0)
		) {
			return;
		}
		this.receive(message);
	}

	fail(error: unknown): void {
		if (this.disposed) {
			return;
		}
		const text = error instanceof Error ? error.message : String(error);
		this.log("error", `The frame stopped: ${text}`);
		this.dispose();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
		for (const own of this.ownLoads.values()) {
			own.reject(new TypeError("The frame is closed"));
		}
		this.ownLoads.clear();
		if (!this.isolate.isDisposed) {
			this.isolate.dispose();
		}
	}

	setTimer(id: number, ms: number): void {
		if (this.disposed) {
			return;
		}
		this.clearTimer(id);
		if (this.timers.size >= MAX_TIMERS) {
			this.log("warn", "Too many timers; this one will not fire");
			return;
		}
		this.timers.set(
			id,
			setTimeout(() => {
				this.timers.delete(id);
				void this.call("timer", id);
			}, ms),
		);
	}

	clearTimer(id: number): void {
		const timer = this.timers.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.timers.delete(id);
		}
	}

	random(length: number): Uint8Array {
		const size = Math.max(0, Math.min(Number(length) | 0, MAX_RANDOM_BYTES));
		return randomFillSync(new Uint8Array(size));
	}

	// The backend's own loads, a script's or a module's source, go to the
	// page with ids below zero, so the frame's own stay above it.
	fetchThroughPage(request: FrameRequest): Promise<FrameResponse> {
		if (this.disposed) {
			return Promise.reject(new TypeError("The frame is closed"));
		}
		const id = this.nextOwnLoad--;
		return new Promise((resolve, reject) => {
			this.ownLoads.set(id, {resolve, reject});
			this.receive({type: "fetch", id, request});
		});
	}

	runScripts(items: ScriptItem[], initial: boolean): void {
		for (const script of items.slice(0, MAX_SCRIPTS - this.scriptCount)) {
			this.scriptCount++;
			const source = script.kind === "classic" && script.src !== null
				? this.loadScript(script.src)
				: null;
			source?.catch(() => {});
			if (script.async) {
				const run = this.runScript(script, source);
				this.asyncScripts.add(run);
				void run.then(() => this.asyncScripts.delete(run));
			} else {
				this.scriptQueue = this.scriptQueue.then(() =>
					this.runScript(script, source),
				);
			}
		}
		if (initial) {
			this.scriptQueue = this.scriptQueue.then(() => this.call("interactive"));
			void this.scriptQueue
				.then(async () => {
					while (this.asyncScripts.size > 0) {
						await Promise.all(this.asyncScripts);
					}
				})
				.then(() => this.call("loaded"));
		}
	}

	async runScript(
		script: ScriptItem,
		source: Promise<string> | null,
	): Promise<void> {
		if (this.disposed) {
			return;
		}
		let ok = true;
		try {
			if (script.kind === "importmap") {
				this.modules.addImportMap(script.text ?? "", this.init.url);
			} else if (script.kind === "module") {
				if (script.src !== null) {
					await this.modules.import(script.src, this.init.url);
				} else {
					await this.modules.importSource(
						script.text ?? "",
						`${this.init.url}#module-${script.id}`,
						this.init.url,
					);
				}
			} else {
				const text = script.src === null
					? script.text ?? ""
					: await (source ?? this.loadScript(script.src));
				await this.execute(script, text);
			}
		} catch (error) {
			ok = false;
			if (this.isFatal(error)) {
				this.fail(error);
				return;
			}
			this.log(
				"error",
				`Uncaught ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
			);
		}
		if (script.src !== null) {
			void this.call("scriptFinished", script.id, ok);
		}
	}

	execute(script: ScriptItem, source: string): Promise<void> {
		const run = this.executing.then(async () => {
			await this.call("scriptBegin", script.id);
			try {
				await this.context.eval(source, {
					filename: script.src ?? this.init.url,
					timeout: this.taskTimeout,
				});
			} finally {
				if (!this.disposed) {
					await this.call("scriptEnd", script.id);
				}
			}
		});
		this.executing = run.catch(() => {});
		return run;
	}

	isFatal(error: unknown): boolean {
		return this.isolate.isDisposed ||
			/timed out|memory limit|disposed/i.test(String(error));
	}

	async loadScript(url: string): Promise<string> {
		const response = await this.fetchThroughPage({
			url,
			method: "GET",
			headers: [["accept", "*/*"]],
			body: null,
			redirect: "follow",
			destination: "script",
			referrer: "",
		});
		if (response.status < 200 || response.status > 299) {
			throw new TypeError(
				`Failed to load the script ${url}: ${response.status}`,
			);
		}
		return new TextDecoder().decode(response.body ?? new Uint8Array());
	}
}
