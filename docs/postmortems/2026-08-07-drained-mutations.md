# Post-mortem: geometry reads stranded drained mutations

**Date:** 2026-08-07 (launch day) · **Fixed in:** `03d4000` · **Severity:**
user-visible interaction freeze in any app navigating via `scrollIntoView`

## Symptom

In the fuzzy-finder example, arrow keys did not move the selection. The DOM
updated correctly on every keypress; the screen never repainted. Under rapid
keypresses after the first fix attempt, the screen updated but stayed exactly
one interaction behind the DOM.

## Root cause

`#processPendingMutationsAndRender()` — the synchronous flush behind
`getBoundingClientRect`, `elementFromPoint`, and `scrollIntoView` — calls
`MutationObserver.takeRecords()` to apply pending mutations before computing
layout, so geometry reads are exact. By design it does **not** paint:
"painting stays with the caller's own render," a deliberate choice to avoid
double paints when a render loop calls `scrollIntoView` per keystroke.

`takeRecords()` does not just *read* the queue; it **empties** it. The
observer callback — the thing that normally paints after any mutation — never
fires for records taken this way. So the contract silently became: *a
mutation followed by a geometry read is painted only if the caller
independently causes a render.* Callers inside the engine's own render paths
always did. An application that mutates and then calls `scrollIntoView` on an
already-visible element causes no camera move, no input event, no further
mutation — nothing renders, ever. The mutation is consumed and lost to the
screen.

## Why five hundred tests never saw it

The masking was systematic, not unlucky:

1. **The test idiom supplies the missing paint.** Every interaction test in
   the suite follows `act(); await nextFrame(dom)` — and `nextFrame` is
   implemented with `requestAnimationFrame`, which *schedules a render*. The
   suite's own convention force-feeds exactly the render this bug fails to
   schedule. Roughly 800 tests exercised mutation-then-paint and all of them
   helped the engine along.
2. **The examples that navigated masked it too.** `tree.ts` and `git-log.ts`
   both `await` a frame inside their refresh functions after
   `scrollIntoView` — cargo-culted robustness that was actually load-bearing.
   The fuzzy finder was the first code to trust the platform contract
   ("mutations are observed and painted"), and it broke immediately.
3. **The mock probe mid-diagnosis was misleading.** Instrumenting event
   dispatch showed keydown firing and `move()` executing with correct state —
   which ruled out everything except the one thing not instrumented: whether
   a paint followed.

## The flawed first fix

Scheduling a render from the drain, guarded by "unless a render is already in
flight" (`if (!this.#isRendering)`), reintroduced the same hole one step
later: keystroke A's paint is in flight when keystroke B's drain runs, B
skips scheduling, and the screen permanently shows state A while the DOM
holds state B. Caught within minutes by driving *batched* keystrokes in
tmux — two Downs moving one row. The guard was superstition: `#render()`
already queues a trailing frame when re-entered; the correct fix is to call
it unconditionally and let the render loop's own coalescing absorb overlap.

## Fixes

- The drain schedules the paint it consumed, unconditionally (`03d4000`).
- A contract test that waits on the **wall clock only** — no `nextFrame`, no
  scroll, no helping hand — through single and back-to-back mutate+drain
  cycles (`tests/attach.test.ts`).
- A tmux harness scenario driving real batched arrow keys through the fuzzy
  finder with no test-side frame anywhere (`scripts/verify-tmux.ts`).

## Lessons

1. **A helper that makes tests pass can be a bug's camouflage.** Any test
   idiom that runs after every action (here: `nextFrame`) deserves suspicion:
   whatever it does, the suite cannot detect the engine failing to do the
   same thing on its own. Wall-clock-only assertions are the antidote and
   the suite now has its first ones.
2. **An API that consumes observer records assumes the observer's
   obligations.** `takeRecords()` is a transfer of responsibility, not a
   peek. Any future caller must either re-emit the records' consequences or
   not take them.
3. **Examples are integration tests.** Every engine gap found this week —
   this one, `position: fixed` under the camera, the whitespace flex items,
   the textarea sizing — was found by an example doing the ordinary thing,
   not by the unit suite. The example set earns its maintenance cost.
