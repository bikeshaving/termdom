---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## TTYOM Project Architecture

**RENAMED FROM TOM → TTYOM (TTY Object Model)** 

See `TTYOM_DESIGN.md` for the complete Terminal Object Model design document. This project implements a revolutionary DOM-like API for terminal UIs using:

- **HappyDOM** for tree structure and events ✅
- **ScreenBuffer** compositing for efficient rendering ✅  
- **Yoga** layout engine for flexbox support
- **Bun APIs** for fast text processing and colors ✅
- **Intl.Segmenter** for proper Unicode text handling ✅

## TypeScript Setup

Strict TypeScript configuration with:
- `strict: true` - No shortcuts, proper type safety
- `target: "es2022"` - Modern JavaScript features
- `lib: ["es2022", "dom", "es2022.intl"]` - Unicode support
- `bun run typecheck` - Check all files
- `bun run typecheck:examples` - Check examples

## Current Status (Updated)

### ✅ COMPLETED
1. **Core Architecture**: TTYWindow, TTYDocument, TTYElement with proper DOM integration
2. **Event System**: Using Happy-DOM's Event classes (not CustomEvent) 
3. **Unicode Support**: Intl.Segmenter for proper grapheme cluster handling
4. **Runtime System**: TTYRuntime abstraction with BunTTYRuntime and MockTTYRuntime
5. **API Migration**: All examples updated from createTOM() to createTTYWindow()
6. **TypeScript Integration**: Strict typing with Happy-DOM compatibility
7. **Text Rendering**: ScreenBuffer with proper Unicode segmentation

### 🚧 IN PROGRESS  
1. **TypeScript Errors**: Some remaining DOM compatibility issues
2. **BunTTYRuntime**: TypeScript errors need fixing

### 📋 PENDING
1. **Yoga Layout**: Full flexbox integration
2. **Advanced Features**: DevTools, CSSOM, CSS parsing
3. **Element Types**: Built-in input, button, container elements

## Key API Changes

- **Entry Point**: `createTTYWindow()` (was `createTOM()`)
- **Terminal Dimensions**: `tty.innerWidth/innerHeight` (was `document.terminalWidth/Height`) 
- **Element Creation**: `tty.document.createElement()` 
- **Rendering**: `tty.document.render()`
- **Cleanup**: `tty[Symbol.dispose]()` (disposable pattern)

## Development Commands

- `bun run typecheck` - Check TypeScript errors
- `bun test` - Run unit tests  
- `bun examples/hello-world.ts` - Run basic example
- All examples work with new TTYWindow API
