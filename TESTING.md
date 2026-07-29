# Testing notes

## Running the suite

```bash
bun run test        # libuild test -p bun -p node
```

The suite runs on **both bun and node**. Node isn't redundant: it exercises the
pure-JS fallbacks (`stringWidthFallback`, the CSS color parser) that bun's native
paths (`Bun.stringWidth`) would otherwise hide, so a divergence between the two
implementations fails a test instead of shipping.

## Why each file runs in its own process

`libuild test` runs **each test file in its own process** (per-file isolation, its
default). That is not a nicety here — it's what makes the suite reliable on bun.

Every test constructs a jsdom `Window`. JSC (bun's engine) collects the JS objects
on teardown but does **not** return the underlying native/off-heap memory to the
OS within a long-lived process — its allocator holds the high-water mark and only
scavenges on idle, which a busy test run never reaches. Run all ~491 tests in one
process and RSS climbs until the machine swaps and the run never finishes; the
same bundle on node (V8) reclaims and passes, because V8 decommits after major
GCs. This is a property of the runtime, not a leak in termdom — heap snapshots
across repeated create/dispose cycles show the JS object graph staying flat while
RSS grows.

Per-file isolation sidesteps it entirely: native memory is freed when each file's
process exits, so no single process accumulates the whole suite's working set.
Files run in parallel, bounded to about `cpus - 1`. None of this affects a real
program — an application has one `TermDOM`.

Because memory is bounded by process lifetime, there is **no** test-harness
disposal net and no setup file. A test may still call `dispose()` for
deterministic teardown, but it is no longer load-bearing for the run to finish.
