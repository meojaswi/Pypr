import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Highlight } from '../../shared/types'
import { drawMarks, flashMarks } from './geometry'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const assetUrl = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href

export const MIN_SCALE = 0.4
export const MAX_SCALE = 4
const PAGE_GAP = 16

interface PageView {
  num: number
  el: HTMLDivElement
  canvasWrap: HTMLDivElement
  hlLayer: HTMLDivElement
  textEl: HTMLDivElement
  linkLayer: HTMLDivElement
  linksDone: boolean
  baseW: number
  baseH: number
  rendered: boolean
  renderTask: RenderTask | null
  textLayer: pdfjs.TextLayer | null
  generation: number
}

export interface ViewerHooks {
  onPageChange(page: number): void
  getHighlights(page: number): Highlight[]
  askPassword(wrongAttempt: boolean): Promise<string | null>
}

export class PdfViewer {
  pdf: PDFDocumentProxy | null = null
  private task: PDFDocumentLoadingTask | null = null
  pages: PageView[] = []
  scale = 1.25
  private observer: IntersectionObserver | null = null
  private lastReportedPage = 0
  private zoomTimer: number | undefined

  constructor(
    private container: HTMLElement,
    private scroller: HTMLElement,
    private hooks: ViewerHooks
  ) {
    this.scroller.addEventListener('scroll', () => this.reportPage(), { passive: true })
  }

  async load(data: Uint8Array, scale: number, startPage: number): Promise<number> {
    this.destroy()
    this.scale = clamp(scale, MIN_SCALE, MAX_SCALE)
    const task = pdfjs.getDocument({
      data,
      cMapUrl: assetUrl('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: assetUrl('standard_fonts'),
      wasmUrl: assetUrl('wasm'),
      iccUrl: assetUrl('iccs')
    })
    this.task = task
    task.onPassword = (update: (password: string) => void, reason: number) => {
      void this.hooks.askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (pw === null) void task.destroy()
        else update(pw)
      })
    }

    const pdf = await task.promise
    if (task !== this.task) return 0
    this.pdf = pdf

    // Show the paper right away using page 1's size, then correct any odd-sized pages.
    const vp = (await pdf.getPage(1)).getViewport({ scale: 1 })
    if (task !== this.task) return 0
    for (let n = 1; n <= pdf.numPages; n++) {
      this.pages.push(this.createPageView(n, vp.width, vp.height))
    }
    this.layout()
    this.observeAll()
    this.goToPage(startPage)
    void this.correctPageSizes(task, startPage)
    return pdf.numPages
  }

  private async correctPageSizes(task: PDFDocumentLoadingTask, startPage: number): Promise<void> {
    const pdf = this.pdf
    if (!pdf) return
    const scrollTop = this.scroller.scrollTop
    let pages: PDFPageProxy[]
    try {
      pages = await Promise.all(this.pages.map((p) => pdf.getPage(p.num)))
    } catch {
      return // document was closed while sizes were loading
    }
    if (task !== this.task) return

    let changed = false
    pages.forEach((page, i) => {
      const vp = page.getViewport({ scale: 1 })
      const p = this.pages[i]
      if (p.baseW !== vp.width || p.baseH !== vp.height) {
        p.baseW = vp.width
        p.baseH = vp.height
        changed = true
      }
    })
    if (!changed) return

    const anchor = this.scroller.scrollTop === scrollTop ? null : this.anchor()
    this.layout()
    if (anchor) this.restoreAnchor(anchor)
    else this.goToPage(startPage)
  }

  private createPageView(num: number, baseW: number, baseH: number): PageView {
    const el = document.createElement('div')
    el.className = 'page'
    el.dataset.page = String(num)

    const canvasWrap = document.createElement('div')
    canvasWrap.className = 'canvas-wrap'
    const hlLayer = document.createElement('div')
    hlLayer.className = 'hl-layer'
    const textEl = document.createElement('div')
    textEl.className = 'textLayer'
    const label = document.createElement('div')
    label.className = 'page-num'
    label.textContent = String(num)

    const linkLayer = document.createElement('div')
    linkLayer.className = 'link-layer'

    el.append(canvasWrap, hlLayer, textEl, linkLayer, label)
    this.container.append(el)
    return {
      num, el, canvasWrap, hlLayer, textEl, linkLayer, linksDone: false, baseW, baseH,
      rendered: false, renderTask: null, textLayer: null, generation: 0
    }
  }

  /** Size every page box for the current scale (cheap — no rendering). */
  private layout(): void {
    for (const p of this.pages) {
      p.el.style.width = `${Math.floor(p.baseW * this.scale)}px`
      p.el.style.height = `${Math.floor(p.baseH * this.scale)}px`
      p.el.style.setProperty('--total-scale-factor', String(this.scale))
      p.el.style.setProperty('--scale-factor', String(this.scale))
      this.drawHighlights(p.num)
    }
  }

  private observeAll(): void {
    this.observer?.disconnect()
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const p = this.pages[Number((e.target as HTMLElement).dataset.page) - 1]
          if (!p) continue
          if (e.isIntersecting) void this.renderPage(p)
          else this.unrenderPage(p) // keeps memory flat on long papers
        }
      },
      { root: this.scroller, rootMargin: '1500px 0px' }
    )
    for (const p of this.pages) this.observer.observe(p.el)
  }

  private async renderPage(p: PageView): Promise<void> {
    if (p.rendered || !this.pdf) return
    p.rendered = true
    const gen = ++p.generation
    const page = await this.pdf.getPage(p.num)
    if (gen !== p.generation) return
    void this.addLinks(p, page)

    const viewport = page.getViewport({ scale: this.scale })
    const dpr = window.devicePixelRatio || 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`

    p.renderTask = page.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
    })
    try {
      await p.renderTask.promise
    } catch (err) {
      if ((err as Error)?.name !== 'RenderingCancelledException') console.error(err)
      return
    } finally {
      p.renderTask = null
    }
    if (gen !== p.generation) return
    p.canvasWrap.replaceChildren(canvas)

    p.textEl.replaceChildren()
    p.textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: p.textEl,
      viewport
    })
    try {
      await p.textLayer.render()
    } catch {
      return
    }
    if (gen !== p.generation) return
    const end = document.createElement('div')
    end.className = 'endOfContent'
    p.textEl.append(end)
  }

  /** Clickable boxes for the page's links, placed in percentages so zoom needs no redraw. */
  private async addLinks(p: PageView, page: PDFPageProxy): Promise<void> {
    if (p.linksDone) return
    p.linksDone = true
    try {
      const annotations = await page.getAnnotations({ intent: 'display' })
      const vp = page.getViewport({ scale: 1 })
      for (const a of annotations) {
        if (a.subtype !== 'Link' || !(a.url || a.dest)) continue
        const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1])
        const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3])
        const link = document.createElement('div')
        link.className = 'pdf-link'
        link.style.left = `${(Math.min(x1, x2) / vp.width) * 100}%`
        link.style.top = `${(Math.min(y1, y2) / vp.height) * 100}%`
        link.style.width = `${(Math.abs(x2 - x1) / vp.width) * 100}%`
        link.style.height = `${(Math.abs(y2 - y1) / vp.height) * 100}%`
        if (a.url) link.title = a.url
        link.onclick = () => {
          if (a.url) window.open(a.url, '_blank') // main process sends it to the real browser
          else void this.goToDest(a.dest)
        }
        p.linkLayer.append(link)
      }
    } catch (err) {
      console.error(err)
    }
  }

  /** The PDF's own table of contents, flattened with a depth for each entry. */
  async getChapters(): Promise<{ title: string; depth: number; go(): void }[]> {
    const outline = (await this.pdf?.getOutline()) ?? []
    const chapters: { title: string; depth: number; go(): void }[] = []
    const add = (items: typeof outline, depth: number) => {
      for (const item of items) {
        chapters.push({
          title: item.title,
          depth,
          go: () => {
            if (item.dest) void this.goToDest(item.dest)
          }
        })
        add(item.items, depth + 1)
      }
    }
    add(outline, 0)
    return chapters
  }

  private async goToDest(dest: string | unknown[]): Promise<void> {
    const pdf = this.pdf
    if (!pdf) return
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
    if (!explicit) return
    const ref = explicit[0] as number | { num: number; gen: number }
    const index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref)
    const mode = (explicit[1] as { name: string }).name
    const destY = mode === 'XYZ' ? explicit[3] : mode === 'FitH' || mode === 'FitBH' ? explicit[2] : null
    let yInPage = 0
    if (typeof destY === 'number') {
      const vp = (await pdf.getPage(index + 1)).getViewport({ scale: 1 })
      yInPage = Math.max(0, vp.convertToViewportPoint(0, destY)[1])
    }
    this.goToPage(index + 1, yInPage)
  }

  private unrenderPage(p: PageView): void {
    p.generation++
    p.rendered = false
    p.renderTask?.cancel()
    p.textLayer?.cancel()
    p.textLayer = null
    const c = p.canvasWrap.querySelector('canvas')
    if (c) {
      c.width = 0
      c.height = 0
    }
    p.canvasWrap.replaceChildren()
    p.textEl.replaceChildren()
  }

  setScale(next: number): void {
    next = clamp(Math.round(next * 100) / 100, MIN_SCALE, MAX_SCALE)
    if (!this.pdf || next === this.scale) return

    // Keep the same spot of the same page under the top of the viewport.
    const anchor = this.anchor()
    this.scale = next
    this.layout()
    this.restoreAnchor(anchor)

    // Re-render after zooming settles (Ctrl+wheel fires many events).
    window.clearTimeout(this.zoomTimer)
    for (const p of this.pages) {
      if (p.rendered) {
        p.renderTask?.cancel()
        p.generation++
        p.rendered = false
        // Leave the old canvas visible, stretched, until the sharp one replaces it.
        const c = p.canvasWrap.querySelector('canvas')
        if (c) {
          c.style.width = '100%'
          c.style.height = '100%'
        }
        p.textEl.replaceChildren()
      }
    }
    this.zoomTimer = window.setTimeout(() => this.observeAll(), 120)
  }

  fitWidth(): void {
    if (!this.pages.length) return
    const avail = this.scroller.clientWidth - 48
    const widest = Math.max(...this.pages.map((p) => p.baseW))
    this.setScale(avail / widest)
  }

  /** Show the whole current page, top to bottom, without scrolling. */
  fitPage(): void {
    const n = this.currentPage()
    const p = this.pages[n - 1]
    if (!p) return
    const byWidth = (this.scroller.clientWidth - 48) / p.baseW
    const byHeight = (this.scroller.clientHeight - PAGE_GAP * 2) / p.baseH
    this.setScale(Math.floor(Math.min(byWidth, byHeight) * 100) / 100)
    this.goToPage(n)
  }

  goToPage(n: number, yInPage = 0): void {
    const p = this.pages[clamp(n, 1, this.pages.length) - 1]
    if (!p) return
    this.scroller.scrollTop = p.el.offsetTop - PAGE_GAP + yInPage * this.scale
    this.reportPage()
  }

  currentPage(): number {
    const probe = this.scroller.scrollTop + this.scroller.clientHeight / 3
    for (const p of this.pages) {
      if (p.el.offsetTop + p.el.offsetHeight + PAGE_GAP / 2 > probe) return p.num
    }
    return this.pages.length || 1
  }

  pageView(n: number): PageView | undefined {
    return this.pages[n - 1]
  }

  drawHighlights(pageNum: number): void {
    const p = this.pages[pageNum - 1]
    if (!p) return
    drawMarks(p.hlLayer, this.hooks.getHighlights(pageNum), this.scale)
  }

  flash(id: string): void {
    flashMarks(this.container, id)
  }

  destroy(): void {
    this.observer?.disconnect()
    this.observer = null
    for (const p of this.pages) this.unrenderPage(p)
    this.pages = []
    this.container.replaceChildren()
    void this.task?.destroy()
    this.task = null
    this.pdf = null
    this.lastReportedPage = 0
  }

  private anchor(): { page: number; frac: number } {
    const n = this.currentPage()
    const p = this.pages[n - 1]
    const frac = (this.scroller.scrollTop - p.el.offsetTop) / p.el.offsetHeight
    return { page: n, frac }
  }

  private restoreAnchor(a: { page: number; frac: number }): void {
    const p = this.pages[a.page - 1]
    if (p) this.scroller.scrollTop = p.el.offsetTop + a.frac * p.el.offsetHeight
  }

  private reportPage(): void {
    const n = this.currentPage()
    if (n !== this.lastReportedPage) {
      this.lastReportedPage = n
      this.hooks.onPageChange(n)
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
