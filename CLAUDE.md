See [CONTRIBUTING.md](./CONTRIBUTING.md) for commands, the rendering invariant,
how the test suite is structured, and style conventions. It applies to agents and
humans alike; keep it as the single copy rather than duplicating rules here.

Two things that are specifically for you:

- Run `bun typecheck`, `bun test` and `bun lint --fix` before calling work done,
  and report failures rather than describing the change as finished.
- IDE diagnostics in this repo go stale often. Verify against a real `bun
  typecheck` before acting on one.
