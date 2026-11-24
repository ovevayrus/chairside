// Glasses screenshots from /api/screenshot/glasses: 576x288 RGBA PNGs where the
// brightness lives in the alpha channel (unlit pixels have alpha 0). Decode with
// pngjs and keep RGBA: converting to RGB merges lit and unlit pixels.
import { PNG } from 'pngjs'

export function decode(png) {
  const image = PNG.sync.read(png)
  return { width: image.width, height: image.height, data: image.data, png }
}

/** Pixels with alpha > 0, over the whole frame or inside an inclusive box. */
export function litPixels(frame, box) {
  const { x0, y0, x1, y1 } = box ?? {
    x0: 0,
    y0: 0,
    x1: frame.width - 1,
    y1: frame.height - 1,
  }
  let lit = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (frame.data[(y * frame.width + x) * 4 + 3] > 0) lit++
    }
  }
  return lit
}

/** Pixels whose brightness (alpha) differs, and the inclusive box around them. */
export function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `frame sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`,
    )
  }
  let changed = 0
  let x0 = a.width
  let y0 = a.height
  let x1 = -1
  let y1 = -1
  for (let pixel = 0; pixel < a.width * a.height; pixel++) {
    if (a.data[pixel * 4 + 3] === b.data[pixel * 4 + 3]) continue
    changed++
    const x = pixel % a.width
    const y = (pixel - x) / a.width
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return { changed, box: changed ? { x0, y0, x1, y1 } : null }
}
