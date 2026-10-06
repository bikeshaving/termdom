---
title: Images and canvas
description: How <img> and <canvas> draw pixels in cells.
---

A cell can show two pixels: the lower half block, `▄`, in the
foreground color under the background color. `<img>` and `<canvas>`
draw that way.

Most terminals draw block characters themselves, so either half fills
its half of the cell exactly. Terminal.app draws them from the font,
and Menlo's and SF Mono's sit low in the cell: the upper half block
leaves a sliver of the wrong color at the top and runs past the
middle. The background fills whatever the glyph leaves, so with the
lower half block only the seam between the two pixels is a little
low. The pixels are ordinary cells, so they scroll, clip and
redraw like text, and they work over SSH and inside tmux.

## `<img>`

```html
<img src="cover.jpg" alt="Album cover">
```

`src` is a URL: `https:`, `data:`, `file:` or any other. A path is
relative to the document's URL, given by the `url` option. A document
at `about:blank` has no URL to resolve against, so a path there names
nothing; a program that shows local files sets `url` to a `file:` URL,
such as its working directory.

### Loading

Nothing loads unless the program allows it. Which loads a document may
make is a Content Security Policy, given as the `csp` option in the
syntax of a `Content-Security-Policy` header. An `<img>` loads only what
`img-src` allows, or `default-src` when there is no `img-src`. The default is `default-src 'none'`.

```ts
// Images from anywhere on the web, and data: URLs.
new TermDOM({csp: "img-src https: data:"});

// A mail client: attachments by cid:, nothing remote.
new TermDOM({csp: "img-src cid: data:"});
```

Source expressions match as CSP Level 3 defines them: `'none'`,
`'self'`, `*`, a scheme such as `https:` or `cid:`, and a host such as
`https://*.example.com:8443/img/`. `*` covers the network schemes and
the document's own, not `data:` or `cid:`. A host given without a
scheme takes the document's scheme, and for a document not served over
the network, as `about:blank` and `file:` are not, the network schemes.

A page can narrow the policy with its own
`<meta http-equiv="Content-Security-Policy">` in its head, and never
widen it: a load must pass every policy. As in a browser, the tag's
policy holds from when it is inserted into the head, and removing the
tag or changing its `content` later changes nothing. A load a policy blocks fires
`securitypolicyviolation` at its element, a `SecurityPolicyViolationEvent`
that bubbles to the document and names the URL, the directive and the
policy. The image shows as a box with its `alt` text. When the program
set no policy, the first blocked load is also reported once where
uncaught errors go: the transport's log, or the scrollback at exit.

A load the policy allows goes to the TermDOM as a `"fetch"` event, a
`FetchEvent`, as a Service Worker hears it, and to the network when no
listener answers. A listener answers with `respondWith()`, which stops
the other listeners. `Response.error()`, a promise that rejects, or
`preventDefault()` without an answer fails the load.

```ts
const term = new TermDOM({csp: "img-src cid: https:"});
term.addEventListener("fetch", (event) => {
  const {request} = event;
  if (request.destination === "image" && request.url.startsWith("cid:")) {
    event.respondWith(new Response(attachment(request.url)));
  }
});
```

The policy comes first, as a page's policy does before its Service
Worker: a load the listener answers must be allowed too, so serving
`cid:` takes both `img-src cid:` and the listener. `request.destination`
says what the load is for (`"image"`). `handled` settles once the load
is answered, and `waitUntil()` keeps `dispose()` waiting for work a
listener goes on with. `dispose()` aborts loads still in flight, which a
listener sees on `request.signal`. A load waiting on a listener's answer
ends when its `src` changes or the TermDOM is disposed, whether or not
the answer ever comes.

A redirect, from the network or from a listener's `Response.redirect()`,
is checked against the policy again and followed on the network, not
offered to the listeners, as a browser follows one without its Service
Worker. A redirect goes only to another `http:` or `https:` URL, and at
most 20 are followed. A listener that answers with `fetch(event.request)`
follows redirects on its own, and its response is checked against the
policy where it ended up, as a browser checks a Service Worker's
response. A violation names the URL the document asked for, never where
it was redirected.

To decide image by image, such as no remote images in quoted mail,
change the markup before it is inserted, as a mail client cleans what
it shows.

The request waits for the script that set the source to finish, so a
listener added just after the markup sees its images. Only a document
whose own URL is `file:` loads `file:` URLs, whatever the policy says,
so untrusted markup in a page at `about:blank` or `https:` cannot read
local files. Node's `fetch` reads no files, and Bun's and Deno's do, so
a program that allows local files on every runtime answers them itself.

The page's own `window.fetch` is the runtime's, and it resolves a
relative URL against the document's, as a browser's does. No policy
governs it and it dispatches no event: in a terminal it is the program,
not untrusted markup, that calls it.

PNG, JPEG, GIF and BMP decode:

| Format | What decodes |
| --- | --- |
| PNG | Every color type and bit depth, palettes, `tRNS` transparency, Adam7 interlacing |
| JPEG | Baseline and progressive, any chroma subsampling, restart markers, grayscale, CMYK and YCCK. The Exif orientation turns the image, as browsers do by default |
| GIF | The first frame, with its transparent color |
| BMP | 1, 4, 8, 16, 24 and 32 bits, RLE4 and RLE8 |

WebP, AVIF and SVG do not decode. Neither do arithmetic-coded or
lossless JPEGs.

`load` and `error` fire as they do in a browser, and `decode()`,
`complete`, `naturalWidth`, `naturalHeight` and `currentSrc` report the
image. `new Image()` makes an `<img>`. `srcset` is read for its `1x`
candidate.

An image that is not showing, because it is still loading, failed to
load or was blocked, is a box with its `alt` text inside, cut with an
ellipsis when it does not fit. The box takes the image's size when the
page gives one, and otherwise fits the text. An empty `alt` marks an
image that is only decoration, and it shows nothing, as does an
`<img>` with neither a `src` nor an `alt`.

### Size

An image's pixels are CSS pixels, so its natural size in cells is its
size divided by the size of a cell. With the `cellSize` option set,
that is the page's cell. With the default unit cell, where a CSS pixel
is a whole cell, an image takes the terminal's cell instead: the engine
asks for its size (XTWINOPS 16) and assumes 8 by 16 until the terminal
answers. A 400 by 400 image is 50 columns by 25 rows under that
assumption.

`width` and `height`, as attributes or in CSS, are lengths like any
other: CSS pixels, which are cells under the unit cell. With only one
of them set, the other follows the image's ratio. `max-width: 100%`
keeps an image inside its container.

On a line, an image is as tall as itself and its top is at the top of
the line.

### Fitting

`object-fit` and `object-position` place the image in its box when the
box has a different shape. `fill` is the default. `contain`, `cover`,
`none` and `scale-down` keep the image's ratio. `image-rendering:
pixelated` or `crisp-edges` picks the nearest pixel instead of
averaging the pixels a cell covers.

### Transparency

A pixel at least half opaque shows, and the rest leave the cell under
them as it was. On an element with a `background-color`, translucent
pixels blend over that color instead.

### Limits

An image file names its size before its pixels, so a few bytes can
ask for gigabytes. As a browser does, the engine checks what a file
asks for before it allocates, and an image past a limit fails to load:

- a response of at most 64 MB, by its declared length and while reading
- at most 32768 pixels to a side and 2^26 pixels in all
- a PNG's data inflated only as far as its image needs
- a JPEG of at most four components and 500 scans

Images decode one at a time on the runtime's web `Worker`, so a large
one does not stall the page. Bun and Deno have one. Node has one from
26.9 behind a flag, so run `node --experimental-web-worker`, or set
`NODE_OPTIONS=--experimental-web-worker`, to decode off the page's
thread there. Without a `Worker`, and in a CommonJS build, images decode
on the page's thread a slice at a time, so input and frames go on
between slices. A decode that takes more than 10 seconds is stopped
and that image fails; the images behind it still decode.

The worker ends a second after its last decode, and when the last
TermDOM is disposed, so it never keeps a finished program running.

A new `src` cancels the request the old one started, and drops its
decode if it is still waiting for its turn. An image whose
box would sample more than 2^26 pixels draws nothing, as does a 2D
canvas past that size. `ImageData` past it throws a `RangeError`, and
a character grid stops at 2^22 cells.

## `<canvas>`

`getContext()` takes two context types.

### `"2d"`

The 2D context draws pixels into a bitmap, `width` by `height`, which
shows like an image. It implements:

- rectangles, paths (lines, arcs, ellipses, Bézier curves, `arcTo`,
  `roundRect`), `Path2D` with SVG path data, filling with the `nonzero`
  and `evenodd` rules, stroking with widths, caps, joins and dashes,
  and `clip()`
- transforms, `save()` and `restore()`
- colors, `createLinearGradient()`, `createRadialGradient()`,
  `createConicGradient()` and `createPattern()`
- `globalAlpha` and the Porter-Duff `globalCompositeOperation` values
  plus `lighter`
- `drawImage()` from an `<img>`, another `<canvas>` or an `ImageBitmap`,
  scaled and cropped
- `getImageData()`, `putImageData()` and `createImageData()`
- `toDataURL()` and `toBlob()`, as PNG
- `isPointInPath()` and `isPointInStroke()`

A terminal has no fonts to rasterize, so `fillText()` and
`strokeText()` draw text as cells over the pixels, at the cell the text
anchor falls in, with `textAlign` and `textBaseline` applied. Painting
over the anchor paints over the text. `measureText()` counts a cell's
width in pixels for each column. Shadows and `filter` keep their values
but draw nothing.

```ts
const canvas = document.createElement("canvas");
canvas.width = 160;
canvas.height = 96;
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#1e3a5f";
ctx.fillRect(0, 0, 160, 96);
ctx.fillStyle = "#ffd27f";
ctx.beginPath();
ctx.arc(80, 48, 30, 0, Math.PI * 2);
ctx.fill();
document.body.append(canvas);
```

Drawing repaints the canvas on the next frame. No DOM change is needed.

### `"charactergrid"`

The character grid context draws cells instead of pixels. The canvas is
`width` columns by `height` rows, and that is its natural size.

```ts
const canvas = document.createElement("canvas");
canvas.width = 20;
canvas.height = 3;
const grid = canvas.getContext("charactergrid");
grid.fillStyle = "#003366";
grid.fillRect(0, 0, 20, 3);
grid.fillStyle = "#ffcc00";
grid.font = "bold";
grid.fillText("score: 42", 1, 1);
grid.strokeStyle = "#5fafff";
grid.lineJoin = "round";
grid.strokeRect(0, 0, 20, 3);
document.body.append(canvas);
```

Lines are box-drawing glyphs. Where two meet they join in a corner, a
tee or a cross, as borders do. A canvas's lines join each other but
not the page's borders around the canvas.

| Member | What it does |
| --- | --- |
| `fillStyle` | A CSS color. `currentcolor`, the default, is the terminal's foreground |
| `strokeStyle` | The lines' color, the same way |
| `lineStyle` | A CSS `border-style`: `solid`, the default, `double`, `dashed`, `dotted` and the rest |
| `lineJoin` | `miter`, the default, or `round`, which curves `strokeRect()`'s corners |
| `font` | Keywords from the CSS `font` shorthand: `bold`, `italic`, `lighter` |
| `textAlign` | `left`, `right`, `center`, `start` or `end` |
| `textDecoration` | `none` or `underline` |
| `fillText(text, x, y, maxWidth?)` | Writes glyphs in the fill color, over the cells' backgrounds. A wide glyph takes two columns |
| `fillRect(x, y, w, h)` | Fills cells with the fill color as their background. `currentcolor` fills them in inverse video |
| `clearRect(x, y, w, h)` | Empties cells |
| `strokeLine(x1, y1, x2, y2)` | A line from one cell to another, both included, along a row or a column. A slanted line draws nothing |
| `strokeRect(x, y, w, h)` | A box around the cells `w` by `h` from (x, y) |
| `drawImage(image, ...)` | Draws an image's pixels, two to a cell. Without a size, the image takes its natural size in cells |
| `getCell(x, y)` | The cell's glyph, colors and attributes, or `null` |
| `measureText(text)` | The text's width in columns |
| `columns`, `rows`, `reset()` | The grid's size, and clearing it |

## Text alone

Pixels can also be written as text: a lower half block in a span
whose `color` is the lower pixel and whose `background-color` is the
upper one.

```html
<pre><span style="color: #61afef; background-color: #e06c75">▄▄▄</span>
<span style="color: #e5c07b; background-color: #98c379">▄▄▄</span></pre>
```

That stays aligned through scrolling, clipping and repaints, as any
text does, but every run of one color pair is an element. An `<img>` or
a `<canvas>` is one element however many pixels it has.
