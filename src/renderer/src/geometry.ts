import type { Highlight, Rect } from '../../shared/types'

/** Draw highlight fills and underlines into a layer, shared by the PDF and article views. */
export function drawMarks(layer: HTMLElement, highlights: Highlight[], s: number): void {
  layer.replaceChildren()
  for (const h of highlights) {
    for (const r of h.rects) {
      const mark = (cls: string, top: number, height: number) => {
        const d = document.createElement('div')
        d.className = `${cls} hl-${h.color}`
        d.dataset.id = h.id
        d.style.left = `${r.x * s}px`
        d.style.top = `${top}px`
        d.style.width = `${r.w * s}px`
        d.style.height = `${height}px`
        layer.append(d)
      }
      if (h.fill !== false) mark('hl', r.y * s, r.h * s)
      if (h.underline) mark('ul', (r.y + r.h) * s - 2, 2)
    }
  }
}

export function flashMarks(container: HTMLElement, id: string): void {
  for (const el of container.querySelectorAll<HTMLElement>(`.hl[data-id="${id}"], .ul[data-id="${id}"]`)) {
    el.classList.remove('flash')
    void el.offsetWidth
    el.classList.add('flash')
  }
}

/**
 * Turn a selection Range into highlight rects for one page, in page units at scale 1.
 * Returns null if the range doesn't touch this page's text layer.
 */
export function rangeToPageRects(
  range: Range,
  textLayer: HTMLElement,
  pageEl: HTMLElement,
  scale: number
): { rects: Rect[]; text: string } | null {
  if (!range.intersectsNode(textLayer)) return null

  // Clamp the selection to this page's text layer.
  const sub = document.createRange()
  sub.selectNodeContents(textLayer)
  if (range.compareBoundaryPoints(Range.START_TO_START, sub) > 0) {
    sub.setStart(range.startContainer, range.startOffset)
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, sub) < 0) {
    sub.setEnd(range.endContainer, range.endOffset)
  }
  if (sub.collapsed) return null

  const text = rangeText(sub, textLayer)
  if (!text) return null

  const origin = pageEl.getBoundingClientRect()
  const raw = Array.from(sub.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5)
  if (!raw.length) return null

  // Drop outliers (e.g. pdf.js's end-of-content filler, or whole-block rects).
  const heights = raw.map((r) => r.height).sort((a, b) => a - b)
  const median = heights[Math.floor(heights.length / 2)]
  const clean = raw.filter((r) => r.height <= median * 2.2 && r.width < origin.width * 0.98)

  const rects = clean.map((r) => ({
    x: (r.left - origin.left) / scale,
    y: (r.top - origin.top) / scale,
    w: r.width / scale,
    h: r.height / scale
  }))
  return { rects: mergeLineRects(rects), text }
}

/**
 * Text of a range inside a pdf.js text layer. Range.toString() glues lines together
 * ("token.The"), so walk the text nodes and add a space whenever a new visual line starts,
 * re-joining words hyphenated across a line break ("trans-\nformer" → "transformer").
 */
export function rangeText(range: Range, root: HTMLElement): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let out = ''
  let prev: DOMRect | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    if (!range.intersectsNode(node)) continue
    let s = node.data
    if (node === range.endContainer) s = s.slice(0, range.endOffset)
    if (node === range.startContainer) s = s.slice(range.startOffset)
    if (!s) continue

    const box = (node.parentElement as HTMLElement).getBoundingClientRect()
    if (prev && out) {
      const newLine = box.top > prev.top + prev.height * 0.5 || box.left < prev.left
      if (newLine) {
        if (/[A-Za-z]-$/.test(out)) {
          if (!keepLineEndHyphen(out, s, root)) out = out.slice(0, -1)
        } else if (!/\s$/.test(out)) out += ' '
      }
    }
    out += s
    prev = box
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Is a hyphen at a line break part of a compound? Without a dictionary this is a best guess:
 * keep it before a capital/digit, or if the same hyphenated word appears elsewhere nearby.
 */
function keepLineEndHyphen(before: string, after: string, root: HTMLElement): boolean {
  const right = after.match(/^\S*?[A-Za-z0-9]+/)?.[0]
  if (!right || !/^[a-z]/.test(right)) return true
  const left = before.match(/([A-Za-z]+)-$/)?.[1]
  return (root.textContent ?? '').split(`${left}-${right}`).length > 2
}

/** Merge rects that sit on the same line and touch, so a highlight is one bar per line. */
export function mergeLineRects(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x)
  const out: Rect[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    const sameLine =
      last &&
      Math.abs(last.y + last.h / 2 - (r.y + r.h / 2)) < Math.min(last.h, r.h) * 0.5 &&
      r.x <= last.x + last.w + Math.max(last.h, r.h) * 0.8
    if (sameLine) {
      const x1 = Math.min(last.x, r.x)
      const y1 = Math.min(last.y, r.y)
      const x2 = Math.max(last.x + last.w, r.x + r.w)
      const y2 = Math.max(last.y + last.h, r.y + r.h)
      Object.assign(last, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
    } else {
      out.push({ ...r })
    }
  }
  return out
}

export function pointInRects(x: number, y: number, rects: Rect[]): boolean {
  return rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
}
