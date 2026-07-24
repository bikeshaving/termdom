# Testing notes

## The suite is close to a memory ceiling

Measured on the current tree:

| | peak RSS |
| --- | --- |
| full suite (458 tests) | **~700–900 MB** |
| same suite, plus one more TermDOM-heavy test | **~1.6 GB, did not finish** |

Adding one test pushed the observed peak from ~700 MB to ~1.6 GB and the run
stopped making progress; on an earlier occasion an equivalent situation OOM'd a
developer machine.

### That 1.6 GB figure is peak RSS of the whole process, not one test's cost

This is worth stating plainly, because an earlier version of this note got it
wrong. Isolated measurement shows:

- One `TermDOM` doing document-mode render + flush, on its own: **~157 MB**
  (~60 MB over Bun's ~97 MB baseline). No runaway allocation.
- Undisposed `TermDOM` instances leak **linearly at ~2–3 MB each** — 60 of them
  add ~135 MB. Modest and steady, no cliff.

So a single test does **not** allocate ~900 MB. Peak RSS is a high-water mark for
the whole process; adding work to a run already near its ceiling can jump the
*sampled* peak by far more than that work actually costs, depending on GC timing
and allocation ordering. The precise mechanism by which one extra test tips a full
run from "finishes at 900 MB" to "does not finish at 1.6 GB" is **not pinned
down** — it is neither a runaway allocation nor an individually expensive test.
Treat the ceiling as real and the exact trigger as not yet understood.

None of this affects a real program: an application has **one** `TermDOM`, which
is ~2–3 MB. This is entirely a test-hygiene concern.

### How this shows up

Confusingly. `bun test` prints **no per-file progress**: you get the banner, then
nothing until a summary at the very end. So a run that never finishes looks
identical to "it hung at the banner before running anything", and it is easy to
conclude a specific test deadlocks when in fact the whole run is just thrashing.

Symptoms of hitting the ceiling:

- Every test file passes on its own.
- Either half of the suite passes on its own.
- The whole suite produces no summary and never exits.
- A per-test `--timeout` does not help, because nothing is stuck on a promise.

### Diagnosing it safely

**Do not** bisect by re-running the whole suite repeatedly, and never run several
suites concurrently — that is what caused the OOM. Each hung run holds its memory,
so overlapping runs stack.

Instead, run once with a memory kill-switch and watch peak RSS:

```bash
( bun test > /tmp/t.log 2>&1 ) & P=$!
PEAK=0
for i in $(seq 1 60); do
  sleep 1
  kill -0 $P 2>/dev/null || break
  R=$(ps -o rss= -p $P | tr -d ' ')
  [ "$R" -gt "$PEAK" ] && PEAK=$R
  [ "$R" -gt 2500000 ] && { kill -9 $P; echo "killed at 2.5GB"; break; }
done
echo "peak: $((PEAK/1024)) MB"
```

### The underlying debt

The suite constructs **171 `TermDOM` instances and disposes only 106**, so roughly
65 leak per run. At ~2–3 MB each that is ~150–200 MB — real, and worth fixing, but
**not** the bulk of the 700–900 MB baseline. Most of the baseline is simply the
aggregate working set of running 458 DOM/layout/xterm tests. The leak does not
dominate; it just removes what little headroom there is.

Disposing the mock's xterm terminals was tried and measured: it made **no
difference** (732 MB vs 702 MB), so that is not worth repeating.

**The fix is to dispose every `TermDOM` a test creates.** It reclaims the leaked
~150–200 MB and restores headroom. Until then, adding a TermDOM-heavy test can tip
the run over, and the failure looks like a hang rather than an out-of-memory
error.

## Known deferred test

`document mode flushes the whole document on exit` is verified by hand — a 30-row
document in a 10-row terminal flushes all 30 rows, in order, with no duplicates
and the prior command's output preserved — but is **not** in the suite, because
adding it is what tips the run over the ceiling described above. It should go back
in once the disposal debt is paid.
