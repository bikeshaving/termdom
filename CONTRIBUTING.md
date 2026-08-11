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

- libuild owns builds, tests, and publishing. `tsconfig.json` is for
  `tsc --noEmit` and editors only.
- Examples import `@b9g/termdom` by name, so build first.
- The suite runs on node as well as bun because node exercises the pure-JS
  fallbacks that bun's native paths hide.
- `libuild test` runs each file in its own process, so one file's engine
  instances, prototypes and module state cannot leak into the next. Don't
  add a shared setup file.

Changes to rendering, resize, or exit behavior should pass the suite and both
`verify:` harnesses — the xterm mock, tmux, and Terminal.app have each
disagreed with the others before.

## COMPATIBILITY.md

Generated, never edited:

```sh
npm run support                                               # regenerate
bun scripts/support-matrix.ts --check # CI runs this
```
