---
title: Binaries
description: Ship a TermDOM program as one executable file, built with Bun or Node.
---

A TermDOM program can ship as one executable file that runs on a
machine with no JavaScript runtime installed. TermDOM is plain
JavaScript with no native or WASM dependencies, so both Bun's and
Node's single-file builds take it as it is.

|  | Bun | Node |
| --- | --- | --- |
| Command | `bun build --compile` | a bundler, then `node --build-sea` |
| Bundles for you | Yes | No |
| Builds for other platforms | Yes, with `--target` | With that platform's `node` binary |
| Size of a small program | About 90 MB | About 150 MB |
| Images decode | On a worker, if you include it | On the main thread |
| `<embed type="application/x-pty">` | Works | With `node-pty` beside the executable |

The sizes are the runtime's, measured on macOS for Apple silicon with
Bun 1.4 and Node 26. TermDOM and a small program add 2 to 4 MB.

The examples below build this program:

```ts
// app.ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
term.document.body.innerHTML = `
  <style>
    .card { border: 1px solid #5fafff; padding: 0 1ch; width: 30ch; }
  </style>
  <div class="card">Hello from a binary</div>
`;
```

## Bun

```sh
bun build --compile app.ts --outfile hello
./hello
```

Bun bundles the program and its dependencies and appends them to a copy
of its runtime. Nothing else is needed.

`--minify` makes the bundle smaller, and `--target` builds for another
platform from the one you are on:

```sh
bun build --compile --minify --target=bun-linux-x64 app.ts --outfile hello-linux
```

The targets are `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`,
`bun-darwin-arm64`, and `bun-windows-x64`.

### Files

A file imported with `type: "file"` is embedded in the executable, and
the import is its path there. To show one as an image, give the
document a `file:` URL, since only a `file:` document loads `file:`
URLs:

```ts
import {pathToFileURL} from "node:url";
import {TermDOM} from "@b9g/termdom";
import logo from "./logo.png" with {type: "file"};

const term = new TermDOM({url: import.meta.url});
term.attach();
term.document.body.innerHTML =
  `<img src="${pathToFileURL(logo)}" alt="Logo">`;
```

### The image worker

[Images decode on a web `Worker`](/guides/images-and-canvas/#decoding),
which TermDOM starts from a file beside its own. A compiled program has
no such file, so its images decode on the main thread, in slices. That
is fine for a few small images.

To keep the worker, add a file named `image-decode.worker.js` beside
your entry file that imports the package's:

```js
// image-decode.worker.js
import "./node_modules/@b9g/termdom/image-decode.worker.js";
```

Then name it as a second entry point:

```sh
bun build --compile app.ts ./image-decode.worker.js --outfile hello
```

The name and the place matter: TermDOM looks for
`image-decode.worker.js` next to the program.

## Node

Node builds an executable from one script, so the program has to be
bundled first. Any bundler that writes one CommonJS file works. With
esbuild:

```sh
npx esbuild app.ts --bundle --platform=node --format=cjs --outfile=app.cjs
```

Describe the build in a JSON file:

```json
{
  "main": "app.cjs",
  "output": "hello",
  "disableExperimentalSEAWarning": true
}
```

On Node 25.5 and later, one command writes the executable:

```sh
node --build-sea sea-config.json
```

On macOS the result has to be signed before it will run. An ad-hoc
signature is enough to run it on your own machine:

```sh
codesign --sign - hello
./hello
```

Without it, macOS kills the program as it starts, with nothing printed.
Linux needs no signature. Windows runs an unsigned executable, and
`signtool` signs one.

The executable is for the platform of the `node` that built it. To
build for another, set `executable` in the JSON file to a `node` binary
for that platform and of the same version, or build on that platform.

### Before Node 25.5

Node 20 and later write a blob, which
[`postject`](https://www.npmjs.com/package/postject) injects into a
copy of `node`. Set `output` to a blob's name, such as
`"sea-prep.blob"`, and run:

```sh
node --experimental-sea-config sea-config.json
cp "$(command -v node)" hello
npx postject hello NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

On macOS, remove the copy's signature before injecting, pass the
segment's name, and sign the result:

```sh
cp "$(command -v node)" hello
codesign --remove-signature hello
npx postject hello NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA
codesign --sign - hello
```

Node's
[single executable applications](https://nodejs.org/api/single-executable-applications.html)
page has the Windows commands.

### Files

List the files to embed under `assets`, each with the name the program
reads it by:

```json
{
  "main": "app.cjs",
  "output": "hello",
  "disableExperimentalSEAWarning": true,
  "assets": {"logo.png": "logo.png"}
}
```

`getAsset()` from `node:sea` returns a file's bytes. A
[`"fetch"` listener](/guides/images-and-canvas/#loading) can serve them
to the page under a scheme of your own:

```ts
import {getAsset} from "node:sea";
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM({csp: "img-src asset:"});
term.addEventListener("fetch", (event) => {
  const {url} = event.request;
  if (url.startsWith("asset:")) {
    event.respondWith(new Response(getAsset(url.slice("asset:".length))));
  }
});
term.attach();
term.document.body.innerHTML = `<img src="asset:logo.png" alt="Logo">`;
```

`node:sea` only works inside an executable, so a program that also runs
from source needs another way to read the file there.

### What a Node executable lacks

- Images decode on the main thread. A CommonJS bundle has no worker to
  start.
- An [`<embed type="application/x-pty">`](/guides/images-and-canvas/)
  runs programs through `node-pty`, a native addon, which a bundler
  cannot put in the script. Ship a `node_modules` directory holding
  `node-pty` beside the executable, or the embed fires `error`.

## Checking a build

Run the executable in a real terminal before you ship it. Piped to a
file or another program, it has no terminal to ask for its size, its
colors, or its graphics support.

A build on a clean machine is the real test: a container, or a CI job
that downloads the executable and runs it, catches a file the program
read from disk and the build did not embed.
