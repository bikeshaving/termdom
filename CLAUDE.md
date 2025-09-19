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

## Development Commands

- `bun typecheck` - Check TypeScript errors
- `bun test` - Run unit tests
- `bun lint --fix` - Run the linter
- `bun examples/hello-world.ts` - Run basic example

Please aim for 0 typechecking errors, 0 linter errors, and 0 test errors each commit.
