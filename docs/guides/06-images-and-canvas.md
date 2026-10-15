---
title: Images and canvas
description: How <img> and <canvas> draw pixels in cells.
---

A cell can show two pixels. The engine draws the lower half block,
`▄`, in the foreground color, and the background color fills the
upper half. `<img>` and `<canvas>` both draw pixels this way. The
pixels are ordinary cells, so they scroll, clip and redraw like text.
They also work over SSH and inside tmux.

Most terminals draw block characters themselves, so each half block
fills exactly half of the cell. Terminal.app draws them from the font
instead. In Menlo and SF Mono the block glyphs sit low in the cell. The
upper half block leaves a thin strip of the wrong color at the top of
the cell and reaches past the middle. The background color fills any
part of the cell the glyph does not cover. With the lower half block,
the only visible flaw is that the line between the two pixels sits a
little low.

Two options control how pixels are drawn: `images` for `<img>`, and
`canvas` for a canvas's `"2d"` context. Each takes one of three values:

- `"auto"` is the default for both. It picks the best method the
  terminal supports. Today that is always cells.
- `"cells"` always draws cells.
- `"none"` draws nothing. An `<img>` loads nothing and shows its `alt`
  text, as a browser does with images turned off. `getContext("2d")`
  returns `null`, so a canvas shows its fallback content. A
  `"termdom-cellgrid"` context still draws cells, but its `drawImage()`
  draws nothing.

A page written for a browser often reads better with `"none"`. Half
blocks blur logos and detailed pictures, and the alt text says what
they show.

```ts
new TermDOM({images: "none", canvas: "none"});
```

## `<img>`

```html
<img src="cover.jpg" alt="Album cover">
```

`src` is a URL with any scheme, such as `https:`, `data:` or `file:`.
A path resolves against the document's URL, which the `url` option
sets. A document at `about:blank` has no URL to resolve against, so a
path there points to nothing. A program that shows local files should
set `url` to a `file:` URL, such as the URL of its working directory.

### Loading

With no policy set, an image loads from wherever its `src` points, as
it does in a browser. A program that shows markup it does not trust,
such as email, limits what can load with the `csp` option:

```ts
// Images from the web and data: URLs only.
new TermDOM({csp: "img-src https: data:"});

// A mail client: attachments by cid:, nothing remote.
new TermDOM({csp: "img-src cid: data:"});
```

The option is a Content Security Policy, written in the same syntax as
a `Content-Security-Policy` header. An `<img>` loads only what
`img-src` allows. When the policy has no `img-src`, `default-src`
decides. When the option is left out or set to `""`, there is no
policy.

Source expressions match as CSP Level 3 defines them. They include
`'none'`, `'self'`, `*`, a scheme such as `https:` or `cid:`, and a
host such as `https://*.example.com:8443/img/`. `*` covers the network
schemes and the document's own scheme. It does not cover `data:` or
`cid:`. A host written without a scheme takes the document's scheme.
For a document that is not served over the network, such as one at
`about:blank` or a `file:` URL, it takes the network schemes instead.

A page can add its own policy with a
`<meta http-equiv="Content-Security-Policy">` tag in its head. This
can only narrow the policy, never widen it, because a load must pass
every policy. The tag's policy takes effect when the tag is inserted
into the head, as in a browser. Removing the tag or changing its
`content` later has no effect.

When a policy blocks a load, the engine fires
`securitypolicyviolation` at the element. The event is a
`SecurityPolicyViolationEvent`. It bubbles to the document and names
the URL, the directive and the policy. The image shows its `alt` text
instead. If the program set no policy, the engine also reports the
first blocked load once, in the place uncaught errors go: the
transport's log, or the scrollback at exit.

When the policy allows a load, the engine first dispatches a `"fetch"`
event on the TermDOM. The event is a `FetchEvent`, the same type a
Service Worker receives. If no listener answers, the request goes to
the network. A listener answers by calling `respondWith()`, which also
stops the other listeners from running. Any of these fails the load:

- answering with `Response.error()`
- answering with a promise that rejects
- calling `preventDefault()` without answering

```ts
const term = new TermDOM({csp: "img-src cid: https:"});
term.addEventListener("fetch", (event) => {
  const {request} = event;
  if (request.destination === "image" && request.url.startsWith("cid:")) {
    event.respondWith(new Response(attachment(request.url)));
  }
});
```

The policy check comes before the listeners, as a page's policy
applies before its Service Worker sees a request. A load that a
listener answers must also pass the policy. To serve `cid:` URLs, a
program needs both `img-src cid:` in its policy and a listener.

Other parts of the event:

- `request.destination` says what the load is for (`"image"`).
- `handled` settles once the load is answered.
- `waitUntil()` makes `dispose()` wait for work a listener continues
  after answering.
- `dispose()` aborts loads that are still in flight. A listener sees
  this on `request.signal`.

A load that is waiting for a listener's answer ends when the image's
`src` changes or the TermDOM is disposed. This happens whether or not
the answer ever arrives.

A redirect can come from the network or from a listener's
`Response.redirect()`. The engine checks each redirect against the
policy again and follows it on the network. It does not offer the
redirect to the listeners, as a browser follows a redirect
without asking its Service Worker. A redirect may only go to an
`http:` or `https:` URL, and the engine follows at most 20.

A listener that answers with `fetch(event.request)` follows redirects
itself. The engine then checks the response against the policy using
the URL where the redirects ended, as a browser does with a Service
Worker's response. A violation report always names the URL the
document asked for, never the URL it was redirected to.

To decide image by image, such as blocking remote images only in
quoted mail, change the markup before inserting it. A mail client
cleans its markup the same way before showing it.

The request waits until the script that set the source finishes. So a
listener added right after the markup still sees that markup's images.

Only a document whose own URL is a `file:` URL can load `file:` URLs.
This holds no matter what the policy says. So untrusted markup in a
page at `about:blank` or an `https:` URL cannot read local files.
Node's `fetch` cannot read files, but Bun's and Deno's can. A program
that wants local files to load on every runtime must answer those
requests in its own listener.

The page's own `window.fetch` resolves a relative URL against the
document's URL, as a browser's does. Its requests take the same path
as the markup's loads:

1. The engine checks them against `connect-src`, or `default-src` when
   the policy has no `connect-src`.
2. The engine offers them to the `"fetch"` listeners.
3. If no listener answers, the engine sends them to the network.

A listener may call `fetch` itself, either while it answers or on the
request it was given. That call goes straight to the network and does
not come back to the listener, as with a Service Worker.

An inline event handler, such as `onerror="..."` in the markup, runs
with full access to everything the program can reach, like the
program's own code. Under a policy, a handler runs only if the policy
allows `'unsafe-inline'` in the first of these directives that it
names: `script-src-attr`, `script-src`, `default-src`. A nonce or hash
in the same list cancels `'unsafe-inline'`. When a handler is blocked,
the engine reports it with `securitypolicyviolation`. Without a policy
every handler runs. Markup the program does not trust therefore needs a
policy, even one that only says `default-src 'none'`.

The engine decodes PNG, JPEG, GIF and BMP:

| Format | What decodes |
| --- | --- |
| PNG | Every color type and bit depth, palettes, `tRNS` transparency, Adam7 interlacing |
| JPEG | Baseline and progressive, any chroma subsampling, restart markers, grayscale, CMYK and YCCK. The engine rotates the image by its Exif orientation, as browsers do by default |
| GIF | The first frame, with its transparent color |
| BMP | 1, 4, 8, 16, 24 and 32 bits, RLE4 and RLE8 |

It does not decode WebP, AVIF or SVG. It also does not decode
arithmetic-coded or lossless JPEGs.

`load` and `error` fire as they do in a browser. `decode()`,
`complete`, `naturalWidth`, `naturalHeight` and `currentSrc` report on
the image. `new Image()` creates an `<img>`. The engine reads `srcset`
only for its `1x` candidate.

An image that is not showing follows HTML's rendering rules:

- An image that failed to load, was blocked or has no `src` shows its
  `alt` text inline, as plain text that wraps like any other text.
- An image that is not showing, has a `src` and has no `alt` attribute
  is an empty box with a border.
- An image that has a size, from `width` and `height` or from CSS, is
  a box of that size with a border and its `alt` text inside. The text
  is cut off with an ellipsis when it does not fit. This applies while
  the image is still loading, or in a quirks-mode document (one with no
  `<!doctype html>`).
- An empty `alt` marks an image as decoration only, and the image shows
  nothing. An `<img>` with neither a `src` nor an `alt` also shows
  nothing.

### Size

An image's natural size in cells is its size in pixels divided by the
size of a cell. When the `cellSize` option is set, the engine uses
that cell size. With the default unit cell, where one CSS pixel is one
whole cell, the engine uses the terminal's real cell size instead. It
asks the terminal for its cell size (XTWINOPS 16) and assumes 8 by 16
pixels until the terminal answers. At 8 by 16, a 400 by 400 image is
50 columns by 25 rows. It asks again when the terminal resizes, so a
font zoom resizes images too. `term.measureCell()` reports the same
measurement to a program, and a `"cellchange"` event announces a new
one.

`naturalWidth` and `naturalHeight` report this size in CSS pixels.
Under the unit cell a CSS pixel is a cell, so this works the way a
browser reports the size of a high-density image. For example, a 400
by 200 file with 8 by 16 pixel cells reports 50 by 13. When the
`cellSize` option is set, a CSS pixel is a pixel, and the natural size
is the file's size.

`width` and `height`, as attributes or in CSS, are lengths like any
other. They are in CSS pixels, which are cells under the unit cell.
When only one of them is set, the other follows the image's aspect
ratio. `max-width: 100%` keeps an image inside its container.

On a line of text, an image keeps its full height, and its top lines up
with the top of the line.

### Fitting

`object-fit` and `object-position` place the image in its box when the
box has a different shape. `fill` is the default. `contain`, `cover`,
`none` and `scale-down` keep the image's aspect ratio. `image-rendering:
pixelated` or `crisp-edges` makes the engine use the nearest pixel
instead of averaging all the pixels a cell covers.

### Transparency

A pixel that is at least half opaque is drawn. A pixel that is less
than half opaque leaves the cell under it unchanged. On an element with
a `background-color`, translucent pixels blend over that color instead.

### Limits

An image file states its size before its pixels, so a few bytes can
ask for gigabytes of memory. Like a browser, the engine checks the
stated size before it allocates memory. An image that goes past any of
these limits fails to load:

- A response can be at most 64 MB. The engine checks both the declared
  length and the bytes as they arrive.
- An image can be at most 32768 pixels on a side and 2^26 pixels in
  total.
- The engine inflates a PNG's data only as far as the image needs.
- A JPEG can have at most four components and 500 scans.

A decoded image keeps all its pixels, at four bytes each, for as long
as it is loaded. So `createImageBitmap()` makes an exact copy. An image
of more than 2^20 pixels also keeps a smaller copy of 2^20 pixels
(4 MB), and the engine draws its cells from that copy.

An image whose box would sample more than 2^26 pixels draws nothing. So
does a 2D canvas past that size. Creating `ImageData` past that size
throws a `RangeError`. A cell grid stops at 2^22 cells.

### Decoding

The engine decodes images one at a time on the runtime's web `Worker`,
so a large image does not stall the page. Bun and Deno have a web
`Worker`. Node has one from version 26.9, behind a flag. To decode off
the page's thread in Node, run `node --experimental-web-worker` or set
`NODE_OPTIONS=--experimental-web-worker`.

Without a `Worker`, and in a CommonJS build, images decode on the
page's thread in 16 ms slices. Input and frames keep running between
slices. If a decode takes more than 10 seconds, the engine stops it and
that image fails to load. The images queued behind it still decode.
The worker ships in the package, and TermDOM starts it on its own.

The worker exits one second after its last decode, or when the last
TermDOM is disposed. It never keeps a finished program running.

On a Node without the flag, a program can supply a `Worker` itself.
TermDOM uses any global `Worker` it finds, so the
[`@b9g/node-webworker`](https://www.npmjs.com/package/@b9g/node-webworker)
shim provides one on Node 18 or later:

```ts
import {Worker} from "@b9g/node-webworker";
globalThis.Worker ??= Worker;
```

If Node already has its own `Worker`, the `??=` leaves it in place.

When an image gets a new `src`, the engine cancels the request for the
old one. If the old image's decode is still waiting its turn, the
engine drops it.

## `<canvas>`

A canvas is laid out at `width` by `height` CSS pixels, as HTML sizes
it, no matter which context it uses. Under the default unit cell a CSS
pixel is a cell, so `<canvas width="40" height="10">` is 40 columns by
10 rows. When the `cellSize` option is set, the attributes are in
pixels, and the canvas covers the cells its pixels fill. CSS sizes a
canvas like any other element.

Without the attributes, a canvas is 300 by 150 pixels, the HTML
default. Under the unit cell, `width` and `height` default to 38 and 9
instead. Those are the cells that 300 by 150 pixels fill at 8 by 16
pixels per cell, so a canvas with no size set comes out about as large
as it would in a browser.

`getContext()` accepts two context types.

### `"2d"`

The 2D context draws pixels into a bitmap of `width` by `height`
pixels, scaled to fit the canvas's box. A cell shows two pixels, one
above the other. So a bitmap twice as tall as its box in cells shows
every pixel. The context supports:

- rectangles, paths (lines, arcs, ellipses, Bézier curves, `arcTo`,
  `roundRect`), `Path2D` with SVG path data, filling with the `nonzero`
  and `evenodd` rules, stroking with widths, caps, joins and dashes,
  and `clip()`
- transforms, `save()` and `restore()`
- colors, `createLinearGradient()`, `createRadialGradient()`,
  `createConicGradient()` and `createPattern()`
- `globalAlpha`, and the Porter-Duff `globalCompositeOperation` values
  plus `lighter`
- `drawImage()` from an `<img>`, another `<canvas>` or an
  `ImageBitmap`, scaled and cropped. `drawImage(image, x, y)` draws an
  image at its natural size, the way Safari draws a high-density image.
  Source rectangles and `createImageBitmap()` use the file's real
  pixels, as in every browser, so `createImageBitmap(image)` is a
  full-resolution copy.
- `getImageData()`, `putImageData()` and `createImageData()`
- `toDataURL()` and `toBlob()`, as PNG
- `isPointInPath()` and `isPointInStroke()`

A terminal has no fonts for the engine to rasterize. So `fillText()`
and `strokeText()` draw text as cells on top of the pixels, starting at
the cell that contains the text's anchor point. They apply
`textAlign`, `textBaseline` and `direction`. Painting pixels over the
anchor point paints over the text. `measureText()` counts each column
of text as one cell's width in pixels. Shadows and `filter` keep their
values, but draw nothing.

The sample below draws 60 by 40 pixels into 60 columns by 20 rows. Each
pixel is half a cell tall, so the circle comes out round:

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

Drawing repaints the canvas on the next frame. The program does not
need to change the DOM.

### `"termdom-cellgrid"`

The cell grid context is experimental. It belongs to TermDOM alone,
has no standard to follow, and may change in a minor release. Its name
carries TermDOM's prefix, the same way browsers once prefixed their own
context types (`"moz-webgl"`, `"webkit-3d"`).

The cell grid context draws cells instead of pixels. It has as many
cells as the canvas's box holds, and `cols` and `rows` report that
count. Under the unit cell that is `width` by `height`. In any mode,
CSS sets the size exactly: `width: 40ch; height: 10ch` holds 40 by 10
cells.

When the box changes size, the cells that still fit keep what was drawn
in them, and the new cells start empty. A terminal treats its screen
the same way when its window is resized. A `ResizeObserver` on the
canvas tells a script when to draw again.

The context's interface is not on `window`. The `@b9g/termdom` package
exports its type as `CanvasCellGridContext`. Importing the package
tells TypeScript that `getContext("termdom-cellgrid")` returns one.

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

Every method takes coordinates in cells and rounds fractional values
to the nearest cell.

Lines are drawn with box-drawing characters. Where two lines meet, they
join in a corner, a tee or a cross, the same way borders do. Lines on
a canvas join each other, but they do not join the page's borders
around the canvas.

| Member | What it does |
| --- | --- |
| `cols`, `rows` | The number of columns and rows the canvas's box holds |
| `fillStyle` | A CSS color. Reading it back gives the same form a 2D context gives. The default, `CanvasText`, is the terminal's own text color, and `Canvas` is its background color. `currentcolor` is the canvas element's `color`, when that is set. A translucent fill blends over the cell. Text less than half opaque draws nothing |
| `strokeStyle` | The color of lines, set the same way as `fillStyle` |
| `lineStyle` | A CSS `border-style`: `solid` (the default), `double`, `dashed`, `dotted`, `none` and the rest |
| `lineJoin` | `miter` (the default); `round`, which rounds the corners of `strokeRect()`; or `bevel`, which draws the same as `miter` |
| `font` | A CSS `font` shorthand, as a 2D context takes it, such as `"bold 1px monospace"`. The weight and style make text bold, dim or italic. A cell has no size or font family to change. A value the shorthand rejects is ignored |
| `textAlign` | `start` (the default), `end`, `left`, `right` or `center` |
| `direction` | `inherit` (the default), which uses the canvas element's CSS `direction`, or `ltr` or `rtl`. Right-to-left text is drawn in display order. The direction also decides which side is `start` and which is `end` |
| `textDecoration` | `none`, or `underline` and `line-through`, alone or together |
| `save()`, `restore()` | Push and pop the settings above, as in a 2D context |
| `fillText(text, x, y, maxWidth?)` | Writes characters in the fill color, on top of the cells' backgrounds. A wide character takes two columns. Text past `maxWidth` columns is cut off. A `maxWidth` of zero or less, or `NaN`, draws nothing |
| `fillRect(x, y, w, h)` | Sets the background of cells to the fill color. A `CanvasText` fill draws the cells in inverse video |
| `clearRect(x, y, w, h)` | Empties cells |
| `strokeLine(x1, y1, x2, y2)` | Draws a line from one cell to another, including both ends, along a row or a column. A diagonal line draws nothing |
| `strokeRect(x, y, w, h)` | Draws a box around the `w` by `h` cells starting at (x, y) |
| `drawImage(image, ...)` | Draws an image's pixels, two to a cell. Without a size, the image takes its natural size in cells |
| `getCell(x, y)` | Returns the cell's `char`, `color` and `background`, and whether it is `bold`, `italic`, `dim`, `underline`, `strikethrough` or `inverse`. Returns `null` for an empty cell |
| `measureText(text)` | Returns the text's width in columns |
| `reset()` | Clears the grid, the settings and the saved settings |
| `isContextLost()` | Always returns `false` |

## Text alone

A program can also write pixels as plain text. Use a lower half block
in a span whose `color` is the lower pixel and whose
`background-color` is the upper pixel.

```html
<pre><span style="color: #61afef; background-color: #e06c75">▄▄▄</span>
<span style="color: #e5c07b; background-color: #98c379">▄▄▄</span></pre>
```

This stays aligned through scrolling, clipping and repaints, like any
text. But every run of one color pair needs its own element. An
`<img>` or a `<canvas>` is a single element no matter how many pixels
it has.
