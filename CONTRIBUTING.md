# Contributing

```sh
npm run build       # libuild -> dist/; run once before the examples
npm test            # node + bun
npm run typecheck
npm run lint -- --fix
npm run verify:tmux      # real-terminal checks (tmux, private socket)
npm run verify:terminal  # Terminal.app (macOS, needs Automation permission)
node examples/hello-world.ts
```

Zero type errors, lint errors, and test failures per commit. Changes to
rendering, resize, or exit behavior should pass the suite and both `verify:`
harnesses — the xterm mock, tmux, and Terminal.app have each disagreed with
the others before.

- libuild owns builds, tests, and publishing. `tsconfig.json` is for
  `tsc --noEmit` and editors only.
- Examples import `@b9g/termdom` by name, so build first.
- The suite runs on node as well as bun because node exercises the pure-JS
  fallbacks that bun's native paths hide.
- `libuild test` runs each file in its own process; bun (JSC) doesn't return
  jsdom's memory within a long-lived process. Don't add a shared setup file.

## Rendering invariant

No painter emits an SGR attribute from a constant. Every cell attribute
traces to a computed style: author rules, the UA sheets, UA shadow parts.
Only `resolveFontWeight`, `cssColorToNumber`, `cellStyleFromComputed`, and
the ANSI renderer know SGR. If a control needs a look, give it a UA rule,
never a literal in the painter.

## SUPPORT.md

Generated, never edited:

```sh
npm run support                                               # regenerate
BUN_JSC_useFTLJIT=false bun scripts/support-matrix.ts --check # CI runs this
```

Each row is a probe that applies the feature to a real document and records
whether the output changed. A `no` can be a fixture bug — give the feature a
context where its effect is observable before believing it. This is the one
script that needs bun; the JIT flag works around oven-sh/bun#36798.

## Style

- `#private` fields, not TypeScript `private`. There's a lint rule.
- Fewer, larger modules. Fold a single-consumer module into its consumer.
- Comments say why — the failure the line prevents — not what the code does.

For hunting rendering bugs, two nets have worked well: a seeded markup
fuzzer asserting every token paints exactly once and that a no-op class
flip repaints identically, and WPT reftests rendered against the mock
terminal. See the git history for both.
