---
title: Images and canvas
description: How <img> and <canvas> draw pixels in cells.
---

A cell can show two pixels: the upper half block, `▀`, in the
foreground color over the background color. `<img>` and `<canvas>`
draw that way. The pixels are ordinary cells, so they scroll, clip and
redraw like text, and they work over SSH and inside tmux.

## `<img>`

```html
<img src="cover.jpg" alt="Album cover">
```

`src` can be a `data:` URL, a `file:` URL, a path, or an `http:` or
`https:` URL. A path is relative to the document's URL. A document at
`about:blank` has no URL to resolve against, so a path there is
relative to the working directory. `http:` and `https:` go through
`fetch()`.

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
candidate. An image that fails to load shows its `alt` text.

### Size

An image's pixels are the screen's pixels, so its natural size in
cells is its size in pixels divided by the size of a cell in pixels.
The engine asks the terminal for the cell size (XTWINOPS 16) and
assumes 8 by 16 until the terminal answers. A 400 by 400 image is 50
columns by 25 rows under that assumption.

`width` and `height`, as attributes or in CSS, are cells, like every
other length. With only one of them set, the other follows the image's
ratio. `max-width: 100%` keeps an image inside its container.

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
document.body.append(canvas);
```

| Member | What it does |
| --- | --- |
| `fillStyle` | A CSS color. `currentcolor`, the default, is the terminal's foreground |
| `font` | Keywords from the CSS `font` shorthand: `bold`, `italic`, `lighter` |
| `textAlign` | `left`, `right`, `center`, `start` or `end` |
| `textDecoration` | `none` or `underline` |
| `fillText(text, x, y, maxWidth?)` | Writes glyphs in the fill color, over the cells' backgrounds. A wide glyph takes two columns |
| `fillRect(x, y, w, h)` | Fills cells with the fill color as their background. `currentcolor` fills them in inverse video |
| `clearRect(x, y, w, h)` | Empties cells |
| `drawImage(image, ...)` | Draws an image's pixels, two to a cell. Without a size, the image takes its natural size in cells |
| `getCell(x, y)` | The cell's glyph, colors and attributes, or `null` |
| `measureText(text)` | The text's width in columns |
| `columns`, `rows`, `reset()` | The grid's size, and clearing it |

## Text alone

Pixels can also be written as text: an upper half block in a span
whose `color` is the upper pixel and whose `background-color` is the
lower one.

```html
<pre><span style="color: #e06c75; background-color: #61afef">▀▀▀</span>
<span style="color: #98c379; background-color: #e5c07b">▀▀▀</span></pre>
```

That stays aligned through scrolling, clipping and repaints, as any
text does, but every run of one color pair is an element. An `<img>` or
a `<canvas>` is one element however many pixels it has.
