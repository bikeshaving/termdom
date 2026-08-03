# Contributing

## Commands

```sh
npm test            # the suite, on node and bun
npm run typecheck   # tsc --noEmit
npm run lint -- --fix
npm run build       # libuild, into dist/
node examples/hello-world.ts
```

Zero type errors, zero lint errors, zero test failures per commit.

Builds, tests and releases all go through **libuild** (`libuild build`,
`libuild test`, `libuild publish`) — it owns the bundling and the declaration
emit, and it deliberately ignores `tsconfig.json` when generating types.
`tsconfig.json` exists for `tsc --noEmit` and your editor, nothing else.

Examples import `@b9g/termdom` by package name, resolved through `exports` to
`dist/`, so `npm run build` has to have run at least once. They are ordinary
Node programs; nothing in the library requires a particular runtime.

One maintainer script still needs Bun: `scripts/support-matrix.ts` imports test
helpers and internal modules through `.js` specifiers that only Bun resolves to
their `.ts` sources. Nothing a *user* of the library touches needs Bun.

## The rendering invariant

**No painter may emit an SGR attribute from a hardcoded constant.** Every
attribute a cell carries — dim, underline, inverse, a color — must trace back to
a computed style on real DOM: element styles, UA shadow trees (the built-in
controls' internals), the UA document stylesheet in `styles.ts`, or author
rules. Only the CSS-value → terminal-attribute mapping layer is allowed to know
about SGR: `resolveFontWeight`, `cssColorToNumber`, `#cellStyleFromComputed`,
and the ANSI renderer. If a control needs a look, give it a UA rule or a UA
shadow part — never a literal in the painter.

`::selection`'s `Highlight`/`HighlightText` pair is the load-bearing example:
that pair *is* CSS's spelling of "swap this cell's colors", and the selection
painters translate exactly it to SGR 7. Delete the rule and selections stop
painting.

## Testing

The suite runs on **both bun and node**. Node isn't redundant — it exercises the
pure-JS fallbacks (`stringWidthFallback`, the CSS color parser) that bun's native
paths (`Bun.stringWidth`) would otherwise hide, so a divergence between the two
fails a test instead of shipping.

`libuild test` runs **each test file in its own process**, and that isolation is
what makes the suite finish on bun. Every test constructs a jsdom `Window`. JSC
collects the JS objects on teardown but does not return the underlying off-heap
memory to the OS within a long-lived process — its allocator holds the
high-water mark and only scavenges on idle, which a busy run never reaches. In
one process, RSS climbs until the machine swaps and the run never ends; the same
bundle on node (V8) passes, because V8 decommits after major GCs. It is a
property of the runtime, not a leak: heap snapshots across repeated
create/dispose cycles show the object graph flat while RSS grows.

Per-file isolation frees that memory when each process exits, so there is no
disposal net and no setup file. A test may call `dispose()` for deterministic
teardown, but the run no longer depends on it. None of this affects a real
program — an application has one `TermDOM`.

## Finding rendering bugs

Unit tests only exercise the shapes they were written for, and the failure mode
that matters here is content silently not painting — which a snapshot cannot
catch, because a snapshot blesses whatever it was shown. Two black-box nets work
much better, and both are worth rebuilding when you need them:

- **A markup fuzzer.** Generate random nested markup from a seeded RNG and
  assert two invariants: every unique token appears *exactly once* in the frame,
  and a no-op `body.className` round-trip repaints identically. The first catches
  dropped and duplicated boxes; the second catches rebuild-path bugs. Pair it
  with an auto-minimizer (unwrap elements, drop declarations, shorten text while
  the same failure holds) — minimizing by hand wastes hours.
- **WPT reftests.** A web-platform-test reftest is a document plus a
  `<link rel="match">` reference that must render identically. Sparse-clone the
  `css/` directories you care about, render both sides to a `MockProcess` and
  compare frames — no browser and no pixel baseline needed. Inline
  `<link rel=stylesheet>` yourself (the engine loads no files) and skip tests
  flagged `ahem` or containing `<script>`. Cell quantization mostly produces
  false *passes*, so treat it as a bug net, not a conformance score.

## The support matrix

`SUPPORT.md` is generated, never edited:

```sh
npm run support                                   # regenerate
BUN_JSC_useFTLJIT=false bun scripts/support-matrix.ts --check   # fail if stale
```

This is the one script that needs Bun, and it also needs the JIT flag: at this
probe count Bun's top tier miscompiles a loop in cssstyle's value parser into an
infinite allocating spin (oven-sh/bun#36798). `npm run support` sets the flag
for you.

Nothing in it is asserted. Each feature carries a probe that applies it to a
real document, renders to a terminal buffer, and reports whether anything a user
could see changed -- geometry, or painted cells. A property the engine parses and
stores but never acts on counts as unsupported, because to a user it is. The CSS
property list comes from `mdn-data`, so "what is there to support" is the
platform's answer rather than our memory of it.

The test values are fixtures, and a bad one produces a false negative -- probing
`width` on a `<span>` once reported the entire box model missing, because width
does not apply to inline boxes. So when a row says `no`, check the probe before
believing it: give the feature a context where its effect is observable, and if
it still reports nothing, that is a real gap. Two of this file's rows started as
fixture bugs and one (`white-space: pre`) turned out to be a real one.

Regenerate after any change that could move a row, and treat a surprising diff
as a finding rather than noise.

## Style

Private fields use ECMAScript `#private`, not TypeScript's `private` — there's a
lint rule. Prefer fewer, larger modules over many small ones; a single-consumer
module belongs folded into its consumer.

Comments carry the *why*, next to the code, especially the failure a line
prevents. That is this project's documentation: it cannot drift, because it sits
on the code it describes and the tests fail when the code moves.
