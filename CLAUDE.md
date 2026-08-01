Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`

For APIs, prefer:
- `Bun.file` over `node:fs`'s readFile/writeFile
- ``Bun.$`ls``` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import {test, expect} from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Rendering invariant: every terminal attribute has a CSS rule behind it

No painter may emit an SGR attribute (dim, underline, inverse, a color,
...) from a hardcoded constant. Every attribute a cell carries must trace
back to a computed style on real DOM: element styles, UA shadow trees
(built-in widgets' internals -- see the input's field parts), the UA
document stylesheet in styles.ts (our html.css -- e.g. ::selection's
Highlight/HighlightText pair, which IS the inverse-video default), or
author rules. The only code allowed to know about SGR is the CSS-value →
terminal-attribute mapping layer (resolveFontWeight, cssColorToNumber,
#cellStyleFromComputed, the ANSI renderer). If a widget needs a look, give
it a UA rule or a UA shadow part -- never a literal in the painter.

## Development Commands

- `bun typecheck` - Check TypeScript errors
- `bun test` - Run unit tests
- `bun lint --fix` - Run the linter
- `bun examples/hello-world.ts` - Run basic example

Please aim for 0 typechecking errors, 0 linter errors, and 0 test errors each commit.
