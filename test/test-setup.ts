import {afterEach} from "bun:test";
import {
	__enableInstanceTracking,
	__disposeTrackedInstances,
} from "../src/internal/termdom.js";

// Many tests construct a TermDOM and never dispose it. Each holds a JSDOM window,
// and across the whole suite the leaked instances erode what little memory
// headroom there is -- enough that the run intermittently fails to finish and CI
// kills it (exit 143). See TESTING.md.
//
// Turn on instance tracking (a no-op in production) and dispose whatever each test
// left behind. This is a safety net, not a licence to skip dispose() -- a test
// that needs deterministic teardown should still call it.
__enableInstanceTracking();
afterEach(() => {
	__disposeTrackedInstances();
});
