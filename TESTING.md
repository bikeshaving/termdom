# Testing notes

## The suite is close to a memory ceiling

Measured on the current tree:

| | peak RSS |
| --- | --- |
| full suite (458 tests) | **~700–900 MB** |
| same suite, plus one more TermDOM-heavy test | **~1.6 GB, does not finish** |

A single additional test that constructs a `TermDOM`, renders, and disposes added
roughly **900 MB** and pushed the run into thrashing. It does not fail — it stops
making progress, and once OOM'd a developer machine outright.

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

The suite constructs **171 `TermDOM` instances and disposes only 106**. Each holds
a JSDOM window, so roughly 65 leak per run. That is the bulk of the baseline, and
it is why there is so little headroom.

Disposing the mock's xterm terminals was tried and measured: it made **no
difference** (732 MB vs 702 MB). The xterm instances are not the hog; the JSDOM
windows are.

**The fix is to dispose every `TermDOM` a test creates.** Until then, adding a
TermDOM-heavy test can tip the suite over, and the failure will look like a hang
rather than an out-of-memory error.

## Known deferred test

`document mode flushes the whole document on exit` is verified by hand — a 30-row
document in a 10-row terminal flushes all 30 rows, in order, with no duplicates
and the prior command's output preserved — but is **not** in the suite, because
adding it is what tips the run over the ceiling described above. It should go back
in once the disposal debt is paid.
