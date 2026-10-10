/**
 * The runtime's timers, taken before installGlobals() can put the
 * window's in their place. The engine's timers are not the page's: the
 * window's report what their callbacks throw as the page's errors, and
 * disposing the TermDOM stops them, which would stop the engine's own
 * work, the waits dispose() itself makes among it.
 */
export const setTimeout: typeof globalThis.setTimeout =
	globalThis.setTimeout.bind(globalThis);
export const clearTimeout: typeof globalThis.clearTimeout =
	globalThis.clearTimeout.bind(globalThis);
export const setInterval: typeof globalThis.setInterval =
	globalThis.setInterval.bind(globalThis);
export const clearInterval: typeof globalThis.clearInterval =
	globalThis.clearInterval.bind(globalThis);
export const queueMicrotask: typeof globalThis.queueMicrotask =
	globalThis.queueMicrotask.bind(globalThis);
