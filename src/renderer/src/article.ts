import { Readability } from '@mozilla/readability'
import type { Highlight } from '../../shared/types'
import { drawMarks, flashMarks, mergeLineRects } from './geometry'

export interface Chapter {
  title: string
  depth: number // 0 for top level
  go(): void
}

/** What the UI needs from a document view, whether it shows a PDF or an article. */
export interface DocViewer {
  getChapters(): Promise<Chapter[]>
  pages: { num: number; rendered: boolean; textEl: HTMLElement; el: HTMLElement }[]
  scale: number
  setScale(next: number): void
  fitWidth(): void
  fitPage?(): void // PDFs only: an article is one long column
  goToPage(n: number, yInPage?: number): void
  currentPage(): number
  drawHighlights(page: number): void
  flash(id: string): void
  destroy(): void
  textAnchor?(range: Range): { start: number; end: number }
}

const COLUMN_WIDTH = 720
const MIN_SCALE = 0.6
const MAX_SCALE = 2.5

/** Pull the readable part out of a web page. Returns null if there is no article to find. */
export function extractArticle(rawHtml: string, url: string): { title: string; html: string } | null {
  const page = new DOMParser().parseFromString(rawHtml, 'text/html')
  const base = page.createElement('base')
  base.href = url // lets Readability turn relative links and images into absolute ones
  page.head.prepend(base)
  const article = new Readability(page).parse()
  if (!article?.content) return null
  const title = article.title || url
  const heading = document.createElement('h1')
  heading.textContent = title
  return { title, html: heading.outerHTML + sanitize(article.content) }
}

function sanitize(html: string): string {
  const clean = new DOMParser().parseFromString(html, 'text/html')
  clean
    .querySelectorAll('script,style,iframe,object,embed,form,link,meta,base,noscript,video,audio,svg')
    .forEach((el) => el.remove())
  for (const el of clean.body.querySelectorAll('*')) {
    for (const { name, value } of Array.from(el.attributes)) {
      const unsafeUrl = /^(href|src)$/i.test(name) && /^\s*(javascript|data|vbscript):/i.test(value)
      if (/^on/i.test(name) || /^(style|class)$/i.test(name) || unsafeUrl) el.removeAttribute(name)
    }
  }
  return clean.body.innerHTML
}

/**
 * Shows an article as one "page". Highlights are anchored by character offsets, so they
 * stay on the right words even after images load and the layout shifts.
 */
export class ArticleViewer implements DocViewer {
  pages: { num: number; rendered: boolean; textEl: HTMLElement; el: HTMLElement; hlLayer: HTMLElement }[] = []
  scale = 1
  private resize: ResizeObserver | null = null
  private restoreFrac: number | null = null

  constructor(
    private container: HTMLElement,
    private scroller: HTMLElement,
    private getHighlights: () => Highlight[]
  ) {
    const userScrolled = () => (this.restoreFrac = null)
    for (const type of ['wheel', 'mousedown', 'keydown']) {
      this.scroller.addEventListener(type, userScrolled, { passive: true })
    }
  }

  load(html: string, scale: number, scrollFrac: number): void {
    this.destroy()
    this.scale = clamp(scale, MIN_SCALE, MAX_SCALE)

    const el = document.createElement('div')
    el.className = 'page article'
    el.dataset.page = '1'
    const hlLayer = document.createElement('div')
    hlLayer.className = 'hl-layer'
    const textEl = document.createElement('div')
    textEl.className = 'article-body'
    textEl.innerHTML = html
    textEl.addEventListener('click', (e) => this.followLink(e))
    el.append(hlLayer, textEl)
    this.container.append(el)
    this.pages = [{ num: 1, rendered: true, textEl, el, hlLayer }]

    this.restoreFrac = scrollFrac
    this.applyScale()
    this.resize = new ResizeObserver(() => this.fitPageToContent())
    this.resize.observe(textEl)
  }

  private followLink(e: MouseEvent): void {
    const a = (e.target as HTMLElement).closest('a')
    if (!a || !window.getSelection()?.isCollapsed) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      this.pages[0].textEl.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView()
    } else if (/^https?:/i.test(a.href)) {
      window.open(a.href, '_blank') // main process sends it to the real browser
    }
  }

  private applyScale(): void {
    const p = this.pages[0]
    p.textEl.style.zoom = String(this.scale)
    p.el.style.width = `${Math.floor(COLUMN_WIDTH * this.scale)}px`
    this.fitPageToContent()
  }

  private fitPageToContent(): void {
    const p = this.pages[0]
    if (!p) return
    p.el.style.height = `${Math.ceil(p.textEl.getBoundingClientRect().height)}px`
    this.drawHighlights()
    if (this.restoreFrac !== null) this.scroller.scrollTop = this.restoreFrac * this.scroller.scrollHeight
  }

  setScale(next: number): void {
    next = clamp(Math.round(next * 100) / 100, MIN_SCALE, MAX_SCALE)
    if (!this.pages.length || next === this.scale) return
    const frac = this.scroller.scrollTop / this.scroller.scrollHeight
    this.scale = next
    this.applyScale()
    this.scroller.scrollTop = frac * this.scroller.scrollHeight
  }

  fitWidth(): void {
    this.setScale((this.scroller.clientWidth - 48) / COLUMN_WIDTH)
  }

  goToPage(_n: number, yInPage = 0): void {
    const p = this.pages[0]
    if (p) this.scroller.scrollTop = p.el.offsetTop - 16 + yInPage * this.scale
  }

  currentPage(): number {
    return 1
  }

  async getChapters(): Promise<Chapter[]> {
    const p = this.pages[0]
    if (!p) return []
    return Array.from(p.textEl.querySelectorAll<HTMLElement>('h1, h2, h3, h4'))
      .filter((h) => h.textContent?.trim())
      .map((h) => ({
        title: h.textContent!.trim(),
        depth: Number(h.tagName[1]) - 1,
        go: () => {
          const top = h.getBoundingClientRect().top - p.el.getBoundingClientRect().top
          this.goToPage(1, top / this.scale)
        }
      }))
  }

  textAnchor(range: Range): { start: number; end: number } {
    const before = document.createRange()
    before.selectNodeContents(this.pages[0].textEl)
    before.setEnd(range.startContainer, range.startOffset)
    const start = before.toString().length
    return { start, end: start + range.toString().length }
  }

  drawHighlights(): void {
    const p = this.pages[0]
    if (!p) return
    const highlights = this.getHighlights()
    for (const h of highlights) {
      if (h.start !== undefined && h.end !== undefined) h.rects = this.rectsFor(h.start, h.end)
    }
    drawMarks(p.hlLayer, highlights, this.scale)
  }

  /** Current on-screen boxes for a span of characters, in units at scale 1. */
  private rectsFor(start: number, end: number): Highlight['rects'] {
    const { textEl, el } = this.pages[0]
    const origin = el.getBoundingClientRect()
    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT)
    const rects: Highlight['rects'] = []
    let pos = 0
    for (let n = walker.nextNode(); n && pos < end; n = walker.nextNode()) {
      const length = (n as Text).length
      const from = Math.max(start - pos, 0)
      const to = Math.min(end - pos, length)
      if (from < to) {
        const part = document.createRange()
        part.setStart(n, from)
        part.setEnd(n, to)
        for (const r of part.getClientRects()) {
          if (r.width <= 0.5 || r.height <= 0.5) continue
          rects.push({
            x: (r.left - origin.left) / this.scale,
            y: (r.top - origin.top) / this.scale,
            w: r.width / this.scale,
            h: r.height / this.scale
          })
        }
      }
      pos += length
    }
    return mergeLineRects(rects)
  }

  flash(id: string): void {
    flashMarks(this.container, id)
  }

  destroy(): void {
    this.resize?.disconnect()
    this.resize = null
    this.pages = []
    this.restoreFrac = null
    this.container.replaceChildren()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
