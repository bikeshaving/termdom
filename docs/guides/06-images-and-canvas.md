---
title: Images and canvas
description: How <img> and <canvas> draw pixels in cells, and how <embed> runs a program.
---

A cell shows two pixels: a lower half block, `▄`, in the foreground
color over the background color. `<img>` and `<canvas>` draw this way,
so their pixels are ordinary cells that scroll, clip, and work over SSH
and in tmux.

Terminal.app draws block characters from the font, and in Menlo and SF
Mono they sit a little low, so the line between the two pixels is
slightly off center.

The `images` option controls `<img>`, and `canvas` controls the `"2d"`
context:

- `"auto"` (default) uses the best method the terminal supports.
  Currently that's always cells.
- `"cells"` always draws cells.
- `"none"` draws nothing. An `<img>` loads nothing and shows its `alt`
  text. `getContext("2d")` returns `null`, so a canvas shows its
  fallback content. A `"termdom-cellgrid"` context still works, but its
  `drawImage()` draws nothing.

Pages written for a browser often read better with `"none"`: half
blocks blur logos and detail, and alt text says what they show.

```ts
new TermDOM({images: "none", canvas: "none"});
```

## `<img>`

```html
<img src="cover.jpg" alt="Album cover">
```

`src` takes any URL scheme, such as `https:`, `data:`, or `file:`.
Relative URLs resolve against the document URL, set by the `url`
option. At the default `about:blank` they resolve to nothing, so a
program that shows local files should set `url` to a `file:` URL.

### Loading

Without a policy, images load from anywhere. To restrict untrusted
markup such as email, set `csp`:

```ts
// Images from the web and data: URLs only.
new TermDOM({csp: "img-src https: data:"});

// A mail client: attachments by cid:, nothing remote.
new TermDOM({csp: "img-src cid: data:"});
```

The value is a `Content-Security-Policy` header. Images load only what
`img-src` allows, or `default-src` if there's no `img-src`. Leaving it
out or setting `""` means no policy.

Sources match per CSP Level 3: `'none'`, `'self'`, `*`, schemes such as
`https:` or `cid:`, and hosts such as `https://*.example.com:8443/img/`.
`*` covers the network schemes and the document's own scheme, but not
`data:` or `cid:`. A host without a scheme takes the document's scheme,
or the network schemes for an `about:blank` or `file:` document.

A page's `<meta http-equiv="Content-Security-Policy">` adds a policy
when it's inserted into the head. It can only narrow the option's
policy, since a load must pass both. Removing or changing the tag later
does nothing.

A blocked load fires a bubbling `securitypolicyviolation` event at the
element, naming the URL, directive, and policy, and the image shows its
`alt` text. If the program set no policy, the first blocked load is
also reported once where uncaught errors go.

An allowed load first fires a `"fetch"` event, a `FetchEvent`, on the
TermDOM. If no listener calls `respondWith()`, the request goes to the
network. The first `respondWith()` stops the other listeners. The load
fails if a listener responds with `Response.error()` or a rejected
promise, or calls `preventDefault()` without responding.

```ts
const term = new TermDOM({csp: "img-src cid: https:"});
term.addEventListener("fetch", (event) => {
  const {request} = event;
  if (request.destination === "image" && request.url.startsWith("cid:")) {
    event.respondWith(new Response(attachment(request.url)));
  }
});
```

The policy is checked before listeners run, so serving `cid:` URLs
takes both `img-src cid:` and a listener.

- `request.destination` is `"image"`.
- `handled` settles once the load is answered.
- `waitUntil()` makes `dispose()` wait for a listener's remaining work.
- `dispose()` aborts loads in flight, through `request.signal`.

A load waiting on a listener ends when the image's `src` changes or the
TermDOM is disposed.

Redirects, from the network or `Response.redirect()`, are rechecked
against the policy and followed on the network without going back to
the listeners. Only `http:` and `https:` targets are followed, at most
20. A listener that responds with `fetch(event.request)` follows
redirects itself, and the response is checked against its final URL.
Violation reports always name the original URL.

To block images selectively, such as remote images in quoted mail,
edit the markup before inserting it.

Requests start after the script that set `src` finishes, so a listener
added right after inserting markup still sees its images.

Only a `file:` document can load `file:` URLs, whatever the policy
says. Node's `fetch` can't read files; Bun's and Deno's can. To load
local files on every runtime, answer those requests in a listener.

The page's `window.fetch` resolves relative URLs against the document
and goes through the same steps: `connect-src` (or `default-src`), then
the `"fetch"` listeners, then the network. A listener's own `fetch`
calls go straight to the network.

Handler attributes such as `onerror="..."` run only with
`scripting: "enabled"`, and then with full access to everything the
program can reach. Under a policy, they run only if the first of
`script-src-attr`, `script-src`, and `default-src` that the policy
names allows `'unsafe-inline'` without a nonce or hash. Blocked handlers
fire `securitypolicyviolation`. Leave scripting off for untrusted
markup.

### Formats

| Format | Supported |
| --- | --- |
| PNG | All color types and bit depths, palettes, `tRNS` transparency, Adam7 interlacing |
| JPEG | Baseline and progressive, any chroma subsampling, restart markers, grayscale, CMYK, YCCK. Rotated by Exif orientation |
| GIF | The first frame, with transparency |
| BMP | 1, 4, 8, 16, 24, and 32 bits, RLE4 and RLE8 |

WebP, AVIF, SVG, and arithmetic-coded or lossless JPEG are not
supported.

`load`, `error`, `decode()`, `complete`, `naturalWidth`,
`naturalHeight`, `currentSrc`, and `new Image()` work. Only the `1x`
`srcset` candidate is used.

An image that isn't showing:

- If it failed, was blocked, or has no `src`, its `alt` text shows
  inline and wraps like other text.
- If it has a `src` and no `alt` attribute, it's an empty bordered box.
- If it has a size from attributes or CSS, and is loading or in a
  quirks-mode document, it's a bordered box of that size with its `alt`
  text inside, cut off with an ellipsis.
- If `alt` is empty, or there's neither `src` nor `alt`, nothing shows.

### Size

An image's natural size in cells is its pixel size divided by the cell
size. With `cellSize` set, that's the cell size used. With the default
unit cell, TermDOM uses the terminal's real cell size (XTWINOPS 16),
assuming 8 by 16 until it answers, so a 400 by 400 image is 50 columns
by 25 rows. It asks again on resize, so zooming the font resizes
images. `term.measureCell()` and the `"cellchange"` event expose the
same measurement.

`naturalWidth` and `naturalHeight` are in CSS pixels. Under the unit
cell that's cells, so a 400 by 200 image with 8 by 16 cells reports 50
by 13. With `cellSize` set, they're the file's pixel size.

`width` and `height`, as attributes or CSS, are CSS pixels. If only one
is set, the other keeps the aspect ratio. `max-width: 100%` keeps an
image inside its container.

Inline, an image keeps its full height, aligned to the top of the line.

### Fitting

`object-fit` and `object-position` place the image when its box is a
different shape. `fill` is the default; `contain`, `cover`, `none`, and
`scale-down` keep the aspect ratio. `image-rendering: pixelated` or
`crisp-edges` samples the nearest pixel instead of averaging.

### Transparency

Pixels at least half opaque are drawn; others leave the cell as it
was. On an element with a `background-color`, translucent pixels blend
over it.

### Limits

Images that exceed these limits fail to load:

- Responses up to 64 MB, checked against the declared length and as
  bytes arrive.
- At most 32768 pixels a side and 2^26 pixels in total, checked before
  allocating.
- PNG data is inflated only as far as the image needs.
- JPEGs up to four components and 500 scans.

Decoded images keep every pixel, at four bytes each, while loaded, so
`createImageBitmap()` is an exact copy. Images over 2^20 pixels also
keep a 2^20-pixel (4 MB) copy to draw cells from.

An image or 2D canvas whose box would sample more than 2^26 pixels
draws nothing, and creating `ImageData` that large throws `RangeError`.
A cell grid is capped at 2^22 cells.

### Decoding

Images decode one at a time on a web `Worker`, so large images don't
stall the page. Bun and Deno have one. Node 26.9 and later have one
behind `--experimental-web-worker`, which you can pass to `node` or set
in `NODE_OPTIONS`.

Without a `Worker`, or in a CommonJS build, images decode on the main
thread in 16 ms slices, with input and frames running between them. A
decode that takes over 10 seconds is stopped and the image fails.

The worker ships with the package and starts on its own. It exits one
second after its last decode, or when the last TermDOM is disposed, and
never keeps a finished program running.

On Node without the flag, any global `Worker` is used, such as the
[`@b9g/node-webworker`](https://www.npmjs.com/package/@b9g/node-webworker)
shim for Node 18 and later:

```ts
import {Worker} from "@b9g/node-webworker";
globalThis.Worker ??= Worker;
```

Changing an image's `src` cancels the old request, and its decode if it
hasn't started.

## `<canvas>`

A canvas is `width` by `height` CSS pixels. Under the unit cell,
`<canvas width="40" height="10">` is 40 columns by 10 rows. With
`cellSize` set, the attributes are pixels. CSS can size it like any
element.

Without attributes, a canvas is HTML's default 300 by 150 pixels, which
under the unit cell becomes 38 by 9 cells, the cells 300 by 150 pixels
fill at 8 by 16.

`getContext()` takes `"2d"` and `"termdom-cellgrid"`.

### `"2d"`

The 2D context draws into a `width` by `height` bitmap, scaled to the
canvas's box at two pixels per cell, one above the other. A bitmap
twice as tall as the box in cells shows every pixel. It supports:

- rectangles, paths (lines, arcs, ellipses, Bézier curves, `arcTo`,
  `roundRect`), `Path2D` with SVG path data, `nonzero` and `evenodd`
  fills, strokes with widths, caps, joins, and dashes, and `clip()`
- transforms, `save()`, and `restore()`
- colors, linear, radial, and conic gradients, and patterns
- `globalAlpha`, the Porter-Duff `globalCompositeOperation` values, and
  `lighter`
- `drawImage()` from an `<img>`, `<canvas>`, or `ImageBitmap`, scaled
  and cropped. `drawImage(image, x, y)` draws at natural size; source
  rectangles use the file's real pixels.
- `getImageData()`, `putImageData()`, and `createImageData()`
- `toDataURL()` and `toBlob()`, as PNG
- `isPointInPath()` and `isPointInStroke()`

There are no fonts to rasterize, so `fillText()` and `strokeText()`
draw text as cells over the pixels, from the cell holding the anchor
point, honoring `textAlign`, `textBaseline`, and `direction`. Pixels
drawn over the anchor cover the text. `measureText()` counts each
column as one cell's width in pixels. Shadows and `filter` draw
nothing.

This draws 60 by 40 pixels into 60 columns by 20 rows, so the circle is
round:

```ts
const canvas = document.createElement("canvas");
canvas.width = 60;
canvas.height = 40;
canvas.style.width = "60ch";
canvas.style.height = "20lh";
const ctx = canvas.getContext("2d")!;
ctx.fillStyle = "#1e3a5f";
ctx.fillRect(0, 0, 60, 40);
ctx.fillStyle = "#ffd27f";
ctx.beginPath();
ctx.arc(30, 20, 15, 0, Math.PI * 2);
ctx.fill();
document.body.append(canvas);
```

Drawing shows on the next frame.

### `"termdom-cellgrid"`

Experimental and specific to TermDOM. It may change in a minor release.

This context draws cells instead of pixels. `cols` and `rows` are how
many cells the canvas's box holds: `width` by `height` under the unit
cell, or exactly what CSS sets, so `width: 40ch; height: 10ch` holds 40
by 10.

When the box resizes, cells that still fit keep their contents and new
cells start empty. Use a `ResizeObserver` to know when to redraw.

The `@b9g/termdom` package exports the type `CanvasCellGridContext`,
and importing it types `getContext("termdom-cellgrid")`.

```ts
const canvas = document.createElement("canvas");
canvas.width = 20;
canvas.height = 3;
const grid = canvas.getContext("termdom-cellgrid")!;
grid.fillStyle = "#003366";
grid.fillRect(0, 0, 20, 3);
grid.fillStyle = "#ffcc00";
grid.font = "bold 1px monospace";
grid.fillText("score: 42", 1, 1);
grid.strokeStyle = "#5fafff";
grid.lineJoin = "round";
grid.strokeRect(0, 0, 20, 3);
document.body.append(canvas);
```

Coordinates are cells, rounded to the nearest. Lines use box-drawing
characters and join each other into corners, tees, and crosses, but not
the page's borders.

| Member | What it does |
| --- | --- |
| `cols`, `rows` | Columns and rows the box holds |
| `fillStyle` | A CSS color. Defaults to `CanvasText`, the terminal's text color; `Canvas` is its background; `currentcolor` is the element's `color`. Translucent fills blend; text under half opacity draws nothing |
| `strokeStyle` | Line color, like `fillStyle` |
| `lineStyle` | A `border-style`: `solid` (default), `double`, `dashed`, `dotted`, `none`, and so on |
| `lineJoin` | `miter` (default), `round` for rounded `strokeRect()` corners, or `bevel`, drawn as `miter` |
| `font` | A CSS `font` shorthand such as `"bold 1px monospace"`. Weight and style give bold, dim, or italic; size and family do nothing. Invalid values are ignored |
| `textAlign` | `start` (default), `end`, `left`, `right`, or `center` |
| `direction` | `inherit` (default, the element's CSS `direction`), `ltr`, or `rtl`. Sets which side is `start` |
| `textDecoration` | `none`, `underline`, `line-through`, or both |
| `save()`, `restore()` | Push and pop the settings above |
| `fillText(text, x, y, maxWidth?)` | Writes text in the fill color over the cells' backgrounds. Wide characters take two columns. Text past `maxWidth` columns is cut; a `maxWidth` of zero or less, or `NaN`, draws nothing |
| `fillRect(x, y, w, h)` | Sets cell backgrounds to the fill color. A `CanvasText` fill draws inverse video |
| `clearRect(x, y, w, h)` | Empties cells |
| `strokeLine(x1, y1, x2, y2)` | A line between two cells, inclusive, along a row or column. Diagonals draw nothing |
| `strokeRect(x, y, w, h)` | A box around `w` by `h` cells at (x, y) |
| `drawImage(image, ...)` | An image's pixels, two per cell, at natural size unless sized |
| `getCell(x, y)` | The cell's `char`, `color`, `background`, and `bold`, `italic`, `dim`, `underline`, `strikethrough`, `inverse`, or `null` if empty |
| `measureText(text)` | Width in columns |
| `reset()` | Clears the grid and settings |
| `isContextLost()` | Always `false` |

## `<embed type="application/x-pty">`

Experimental. It may change in a minor release.

The embed runs `src` with `/bin/sh -c` and draws the program's screen
in its box.

```html
<embed type="application/x-pty" src="htop" width="80" height="24">
```

Nothing runs unless the `pty` option allows it:

```ts
new TermDOM({pty: "auto"});
```

Under `"auto"`, Bun uses its own pseudo-terminal and Node uses
`node-pty` if it is installed. Elsewhere, and under `"none"` (the
default), the embed fires `error`.

### Size

`width` and `height` are CSS pixels, so columns and rows under the unit
cell. The default is 80 by 24. The program is resized to the box.

The embed keeps 2000 lines of scrollback. `scrollback` sets another
number, and `0` keeps none.

### Input

A focused embed sends every key to the program, Tab, Escape and Ctrl+C
included, and pastes too. To keep a key, cancel its `keydown`:

```ts
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "q") {
    event.preventDefault();
    leave();
  }
}, true);
```

A program that asks for the mouse gets clicks, drags and the wheel in
its box. Cancel `pointerdown`, `mousedown` or `wheel` to keep one.
Otherwise the wheel scrolls the scrollback, then the page.

A program that asks for focus reports is told when the embed gains and
loses focus.

`postMessage()` sends input while the program runs. A string goes as
is, so `\r` is Enter. A `keydown` or `paste` event, or an object with
its fields, goes as the user's would. After the program ends it throws
`InvalidStateError`.

```ts
embed.postMessage("make\r");
embed.postMessage({type: "keydown", key: "c", ctrlKey: true});
```

### Events

- `load`: the program started.
- `error`: it could not start.
- `close`: it ended. A `CloseEvent` whose `code` is the exit code, and
  whose `wasClean` is false if a signal killed it. The last screen
  stays.
- `titlechange`: a `CustomEvent` with the new title in `detail`.
- `bell`: the program rang the bell.

### Limits

- The 16 basic colors are xterm's, not the outer terminal's.
- Images the program draws don't show.
- Links (OSC 8) show underlined, but can't be followed.

## Pixels as text

You can also write pixels as text: a lower half block in a span whose
`color` is the lower pixel and `background-color` the upper.

```html
<pre><span style="color: #61afef; background-color: #e06c75">▄▄▄</span>
<span style="color: #e5c07b; background-color: #98c379">▄▄▄</span></pre>
```

Each run of one color pair needs its own element, while an `<img>` or
`<canvas>` is one element however many pixels it has.
