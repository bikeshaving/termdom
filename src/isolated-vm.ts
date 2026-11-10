/**
 * Frames in V8 isolates of their own, made with the isolated-vm
 * package, with limits and a log of the embedder's choosing:
 *
 *   new TermDOM({isolatedFrames: await createIsolatedVMFrames({
 *     memoryLimit: 64,
 *     taskTimeout: 5000,
 *   })});
 *
 * Each frame its isolator starts reports what it has used through
 * `stats()`. isolated-vm is an optional peer dependency, and loads on
 * Node only.
 * @experimental The options and the frames' stats may change in a minor
 * release.
 */
export {
	createIsolatedVMFrames,
	type IsolatedVMOptions,
} from "./internal/isolatedvm.ts";
