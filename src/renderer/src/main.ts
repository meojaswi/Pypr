import './styles.css'
import type { DocAnnotations, Highlight, HighlightColor, LibraryEntry, OpenedDoc } from '../../shared/types'
import { pointInRects, rangeText, rangeToPageRects } from './geometry'
import { PdfViewer } from './viewer'
import { ArticleViewer, extractArticle, type DocViewer } from './article'
import { explain, initAi } from './ai'

const api = window.reader
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const els = {
  library: $('library'),
  reader: $('reader'),
  scroller: $('scroller'),
  pages: $('pages'),
  sidebar: $('sidebar'),
  title: $('doc-title'),
  zoomCurrent: $<HTMLOptionElement>('zoom-current'),
  zoomSelect: $<HTMLSelectElement>('zoom-select'),
  pageInput: $<HTMLInputElement>('page-input'),
  pageCount: $('page-count'),
  hlList: $('hl-list'),
  hlEmpty: $('hl-empty'),
  hlCount: $('hl-count'),
  libList: $('lib-list'),
  libEmpty: $('lib-empty'),
  selBar: $('sel-toolbar'),
  theme: $<HTMLSelectElement>('theme-select'),
  toast: $('toast')
}

const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink']

let doc: Omit<OpenedDoc, 'data'> | null = null
let ann: DocAnnotations | null = null
let filter: HighlightColor | 'all' = 'all'
let saveTimer: number | undefined
let markFill = true
let markUnderline = false

const pdfViewer = new PdfViewer(els.pages, els.scroller, {
  onPageChange(n) {
    els.pageInput.value = String(n)
    if (ann) {
      ann.lastPage = n
      scheduleSave()
    }
  },
  getHighlights: (page) => ann?.highlights.filter((h) => h.page === page) ?? [],
  askPassword
})
const articleViewer = new ArticleViewer(els.pages, els.scroller, () => ann?.highlights ?? [])
let viewer: DocViewer = pdfViewer

function askPassword(wrongAttempt: boolean): Promise<string | null> {
  const dialog = $<HTMLDialogElement>('pw-dialog')
  const input = $<HTMLInputElement>('pw-input')
  $('pw-label').textContent = wrongAttempt ? 'Wrong password. Try again:' : 'This PDF is password-protected:'
  input.value = ''
  dialog.returnValue = ''
  dialog.showModal()
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? input.value : null), { once: true })
  })
}

// ---------- Opening documents ----------

// ---------- Tabs ----------
// Only the active tab is rendered; the others just keep their data and reading position.

interface Tab {
  opened: OpenedDoc
  scrollTop: number // -1 until the tab has been left once
}
let tabs: Tab[] = []
let activeTab: Tab | null = null

function rememberPosition(): void {
  if (activeTab && doc) activeTab.scrollTop = els.scroller.scrollTop
}

function renderTabs(): void {
  const strip = $('tabs')
  strip.classList.toggle('hidden', tabs.length === 0)
  const items = tabs.map((tab) => {
    const name = tab.opened.annotations.title || tab.opened.title
    const el = document.createElement('div')
    el.className = `tab${tab === activeTab ? ' active' : ''}`
    el.title = name
    const label = document.createElement('button')
    label.className = 'tab-label'
    label.textContent = name
    label.onclick = () => void activateTab(tab)
    const close = document.createElement('button')
    close.className = 'tab-close'
    close.title = 'Close tab (Ctrl+W)'
    close.textContent = '×'
    close.onclick = () => void closeTab(tab)
    el.onauxclick = (e) => {
      if (e.button === 1) void closeTab(tab)
    }
    el.append(label, close)
    return el
  })
  const add = document.createElement('button')
  add.className = 'tab-new'
  add.title = 'Open another paper or article'
  add.textContent = '+'
  add.onclick = () => void goHome()
  strip.replaceChildren(...items, add)
}

async function goHome(): Promise<void> {
  rememberPosition()
  await flushSave()
  viewer.destroy()
  doc = null
  ann = null
  activeTab = null
  showView('library')
  renderTabs()
}

async function closeTab(tab: Tab): Promise<void> {
  const index = tabs.indexOf(tab)
  if (index < 0) return
  tabs = tabs.filter((t) => t !== tab)
  if (tab !== activeTab) return renderTabs()
  const next = tabs[index] ?? tabs[index - 1]
  if (next) await activateTab(next)
  else await goHome()
}

function cycleTab(step: number): void {
  if (!tabs.length) return
  const from = activeTab ? tabs.indexOf(activeTab) : step > 0 ? -1 : 0
  void activateTab(tabs[(from + step + tabs.length) % tabs.length])
}

/** Show a document in a new tab, or switch to its tab if it is already open. */
async function openDoc(opened: OpenedDoc | null): Promise<void> {
  if (!opened) return
  let tab = tabs.find((t) => t.opened.docId === opened.docId)
  if (!tab) {
    tab = { opened, scrollTop: -1 }
    tabs.push(tab)
  }
  await activateTab(tab)
}

async function activateTab(tab: Tab): Promise<void> {
  if (tab === activeTab) return
  const opened = tab.opened
  rememberPosition()
  await flushSave()
  activeTab = tab
  renderTabs()
  const { data, html, ...rest } = opened
  viewer.destroy()
  viewer = opened.kind === 'article' ? articleViewer : pdfViewer
  document.body.classList.toggle('is-article', opened.kind === 'article')
  $<HTMLOptionElement>('zoom-fit-page').hidden = opened.kind === 'article'
  doc = rest
  ann = opened.annotations
  els.title.textContent = ann.title || doc.title
  document.title = `${ann.title || doc.title} — Pypr`
  showView('reader')
  try {
    let n = 1
    if (opened.kind === 'article') articleViewer.load(html ?? '', ann.zoom, ann.scrollFrac ?? 0)
    else n = await pdfViewer.load(data.slice(), ann.zoom, ann.lastPage) // pdf.js consumes the copy it is given
    if (ann !== opened.annotations) return // another paper was opened meanwhile
    if (opened.kind !== 'article' && tab.scrollTop >= 0) els.scroller.scrollTop = tab.scrollTop
    els.pageCount.textContent = `/ ${n}`
    updateZoomLabel()
    renderSidebar()
    void renderChapters(opened.annotations)
  } catch (err) {
    if (ann !== opened.annotations) return
    console.error(err)
    viewer.destroy()
    tabs = tabs.filter((t) => t !== tab)
    activeTab = null
    renderTabs()
    window.clearTimeout(saveTimer)
    saveTimer = undefined
    doc = null
    ann = null
    if ((err as Error)?.name === 'InvalidPDFException') await api.removeFromLibrary(opened.docId)
    toast('Could not open this PDF')
    showView('library')
  }
}

async function openArticle(rawUrl: string): Promise<void> {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
  const saved = await api.openSavedArticle(url)
  if (saved) return openDoc(saved)
  toast('Loading link…')
  const fetched = await api.fetchUrl(url)
  if (!fetched) return toast('Could not load that link')
  if (fetched.kind === 'pdf') return openDoc(fetched.doc)
  const article = extractArticle(fetched.html, url)
  if (!article) return toast('Could not find an article on that page')
  await openDoc(await api.saveArticle(url, article.title, article.html))
}

function askArticleUrl(): void {
  const dialog = $<HTMLDialogElement>('url-dialog')
  const input = $<HTMLInputElement>('url-input')
  input.value = ''
  dialog.returnValue = ''
  dialog.addEventListener(
    'close',
    () => {
      const url = input.value.trim()
      if (dialog.returnValue === 'ok' && url) void openArticle(url)
    },
    { once: true }
  )
  dialog.showModal()
}

async function openPath(p: string): Promise<void> {
  if (/^https?:\/\//i.test(p)) return openArticle(p)
  const opened = await api.openPath(p)
  if (!opened) {
    toast('File not found — it may have been moved or deleted')
    return
  }
  await openDoc(opened)
}

async function renderChapters(forDoc: DocAnnotations): Promise<void> {
  const list = $('ch-list')
  list.replaceChildren()
  $('ch-empty').classList.add('hidden')
  const chapters = await viewer.getChapters().catch((err) => {
    console.error(err)
    return []
  })
  if (ann !== forDoc) return // another document was opened meanwhile
  $('ch-empty').classList.toggle('hidden', chapters.length > 0)
  list.replaceChildren(
    ...chapters.map((c) => {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.className = 'ch-item'
      b.style.paddingLeft = `${12 + Math.min(c.depth, 5) * 14}px`
      b.textContent = c.title
      b.title = c.title
      b.onclick = () => c.go()
      li.append(b)
      return li
    })
  )
}

function showView(v: 'library' | 'reader'): void {
  els.library.classList.toggle('hidden', v !== 'library')
  els.reader.classList.toggle('hidden', v !== 'reader')
  document.body.classList.toggle('has-doc', v === 'reader')
  hideSelBar()
  if (v === 'library') {
    els.title.textContent = ''
    document.title = 'Pypr'
    void renderLibrary()
  }
}

// ---------- Saving ----------

function scheduleSave(): void {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void flushSave(), 400)
}

async function flushSave(): Promise<void> {
  window.clearTimeout(saveTimer)
  saveTimer = undefined
  if (ann) {
    ann.zoom = viewer.scale
    try {
      await api.saveAnnotations(ann)
    } catch (err) {
      console.error(err)
      toast('Could not save highlights')
    }
  }
}

api.onBeforeClose(() => void flushSave().finally(() => api.closeReady()))

// ---------- Highlighting ----------

function currentRange(): Range | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!els.pages.contains(range.commonAncestorContainer)) return null
  return range
}

function setMarksHidden(hidden: boolean): void {
  document.body.classList.toggle('marks-hidden', hidden)
  const btn = $('btn-marks')
  btn.classList.toggle('active', hidden)
  btn.textContent = hidden ? 'Show marks' : 'Hide marks'
}
const marksHidden = () => document.body.classList.contains('marks-hidden')
$('btn-marks').onclick = () => setMarksHidden(!marksHidden())

function createHighlight(color: HighlightColor): Highlight | null {
  const range = currentRange()
  if (!range || !ann) return null
  setMarksHidden(false) // a new mark must be visible, or it looks like nothing happened

  let first: Highlight | null = null
  for (const p of viewer.pages) {
    if (!p.rendered) continue
    const res = rangeToPageRects(range, p.textEl, p.el, viewer.scale)
    if (!res) continue
    const h: Highlight = {
      id: crypto.randomUUID(),
      page: p.num,
      rects: res.rects,
      text: res.text,
      color,
      fill: markFill,
      underline: markUnderline,
      ...viewer.textAnchor?.(range),
      note: '',
      createdAt: Date.now()
    }
    ann.highlights.push(h)
    viewer.drawHighlights(p.num)
    first ??= h
  }
  window.getSelection()?.removeAllRanges()
  hideSelBar()
  if (first) {
    renderSidebar()
    scheduleSave()
  }
  return first
}

function deleteHighlight(id: string): void {
  if (!ann) return
  const h = ann.highlights.find((x) => x.id === id)
  if (!h) return
  ann.highlights = ann.highlights.filter((x) => x.id !== id)
  viewer.drawHighlights(h.page)
  renderSidebar()
  scheduleSave()
}

function setColor(id: string, color: HighlightColor): void {
  const h = ann?.highlights.find((x) => x.id === id)
  if (!h) return
  h.color = color
  viewer.drawHighlights(h.page)
  renderSidebar()
  scheduleSave()
}

/** Turn a highlight's fill or underline on/off. A mark always keeps at least one of them. */
function toggleExistingMark(id: string, kind: 'fill' | 'underline'): void {
  const h = ann?.highlights.find((x) => x.id === id)
  if (!h) return
  const fill = h.fill !== false
  const underline = !!h.underline
  if (kind === 'fill' ? fill && !underline : underline && !fill) return
  if (kind === 'fill') h.fill = !fill
  else h.underline = !underline
  viewer.drawHighlights(h.page)
  renderSidebar()
  scheduleSave()
}

/** Choose what the next mark will be. At least one of the two stays on. */
function toggleNextMark(kind: 'fill' | 'underline'): void {
  if (kind === 'fill' ? markFill && !markUnderline : markUnderline && !markFill) return
  if (kind === 'fill') markFill = !markFill
  else markUnderline = !markUnderline
  $('sel-fill').classList.toggle('active', markFill)
  $('sel-underline').classList.toggle('active', markUnderline)
}

function jumpTo(h: Highlight): void {
  const top = Math.min(...h.rects.map((r) => r.y))
  viewer.goToPage(h.page, Math.max(0, top - 80 / viewer.scale))
  window.setTimeout(() => viewer.flash(h.id), 60)
}

// Selection toolbar
function showSelBar(): void {
  const range = currentRange()
  if (!range) return hideSelBar()
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
  if (!rects.length) return hideSelBar()
  const top = Math.min(...rects.map((r) => r.top))
  const left = Math.min(...rects.map((r) => r.left))
  const right = Math.max(...rects.map((r) => r.right))
  const bar = els.selBar
  bar.classList.remove('hidden')
  const bw = bar.offsetWidth
  const x = Math.min(window.innerWidth - bw - 8, Math.max(8, (left + right) / 2 - bw / 2))
  const y = top - bar.offsetHeight - 10
  bar.style.left = `${x}px`
  bar.style.top = `${y < 56 ? Math.max(...rects.map((r) => r.bottom)) + 10 : y}px`
}

function hideSelBar(): void {
  els.selBar.classList.add('hidden')
}

els.pages.addEventListener('mousedown', (e) => {
  hideSelBar()
  const tl = (e.target as HTMLElement).closest('.textLayer')
  if (tl) {
    tl.classList.add('selecting')
    const done = () => {
      tl.classList.remove('selecting')
      document.removeEventListener('mouseup', done)
    }
    document.addEventListener('mouseup', done)
  }
})

els.pages.addEventListener('mouseup', (e) => {
  window.setTimeout(() => {
    if (currentRange()) return showSelBar()
    // Plain click: did it land on an existing highlight?
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>('.page')
    if (!pageEl || !ann || marksHidden()) return
    const r = pageEl.getBoundingClientRect()
    const x = (e.clientX - r.left) / viewer.scale
    const y = (e.clientY - r.top) / viewer.scale
    const pageNum = Number(pageEl.dataset.page)
    const hit = ann.highlights.find((h) => h.page === pageNum && pointInRects(x, y, h.rects))
    if (hit) focusSidebarItem(hit.id, false)
  }, 0)
})

els.selBar.addEventListener('mousedown', (e) => e.preventDefault()) // keep the selection alive
els.selBar.addEventListener('click', (e) => {
  const t = e.target as HTMLElement
  const color = t.dataset.color as HighlightColor | undefined
  if (color) createHighlight(color)
  else if (t.id === 'sel-fill') toggleNextMark('fill')
  else if (t.id === 'sel-underline') toggleNextMark('underline')
  else if (t.id === 'sel-note') addNoteHighlight()
  else if (t.id === 'sel-copy') copySelection()
  else if (t.id === 'sel-explain') explainSelection()
})

function explainSelection(): void {
  const range = currentRange()
  if (!range || !ann || !doc) return
  const text = rangeText(range, els.pages)
  if (!text) return
  const kept = range.cloneRange()
  hideSelBar()
  void explain(text, ann.title || doc.title, (answer) => {
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(kept)
    const h = createHighlight('yellow')
    if (!h) return
    h.note = answer
    renderSidebar()
    scheduleSave()
    focusSidebarItem(h.id, false)
  })
}

function addNoteHighlight(): void {
  const h = createHighlight('yellow')
  if (h) focusSidebarItem(h.id, true)
}

function copySelection(): void {
  const range = currentRange()
  const text = range ? rangeText(range, els.pages) : ''
  if (text) void navigator.clipboard.writeText(text).then(() => toast('Copied'))
  hideSelBar()
}

els.scroller.addEventListener('scroll', () => {
  if (!els.selBar.classList.contains('hidden')) showSelBar()
  if (doc?.kind === 'article' && ann) {
    ann.scrollFrac = els.scroller.scrollTop / els.scroller.scrollHeight
    scheduleSave()
  }
}, { passive: true })

// ---------- Sidebar ----------

function sortedHighlights(): Highlight[] {
  if (!ann) return []
  return [...ann.highlights].sort(
    (a, b) => a.page - b.page || Math.min(...a.rects.map((r) => r.y)) - Math.min(...b.rects.map((r) => r.y))
  )
}

function renderSidebar(): void {
  const all = sortedHighlights()
  const list = filter === 'all' ? all : all.filter((h) => h.color === filter)
  els.hlCount.textContent = String(all.length)
  els.hlEmpty.classList.toggle('hidden', list.length > 0)
  els.hlEmpty.textContent = all.length ? 'No highlights in this color.' : 'Select text in the paper to highlight it.'

  els.hlList.replaceChildren(
    ...list.map((h) => {
      const li = document.createElement('li')
      li.className = 'hl-item'
      li.dataset.id = h.id

      const head = document.createElement('div')
      head.className = 'hl-head'
      const dot = document.createElement('button')
      dot.className = `dot ${h.color}`
      dot.title = 'Change color'
      dot.onclick = () => setColor(h.id, COLORS[(COLORS.indexOf(h.color) + 1) % COLORS.length])
      const page = document.createElement('span')
      page.className = 'muted'
      page.textContent = `p. ${h.page}`
      const del = document.createElement('button')
      del.className = 'icon del'
      del.title = 'Delete highlight'
      del.textContent = '×'
      del.onclick = () => deleteHighlight(h.id)
      const fillBtn = document.createElement('button')
      fillBtn.className = `mark-toggle${h.fill !== false ? ' active' : ''}`
      fillBtn.title = 'Highlight on/off'
      fillBtn.textContent = 'H'
      fillBtn.onclick = () => toggleExistingMark(h.id, 'fill')
      const underlineBtn = document.createElement('button')
      underlineBtn.className = `mark-toggle u${h.underline ? ' active' : ''}`
      underlineBtn.title = 'Underline on/off'
      underlineBtn.textContent = 'U'
      underlineBtn.onclick = () => toggleExistingMark(h.id, 'underline')
      head.append(dot, page, fillBtn, underlineBtn, del)

      const text = document.createElement('blockquote')
      text.className = `hl-text ${h.color}`
      text.textContent = h.text
      text.title = 'Jump to highlight'
      text.onclick = () => jumpTo(h)

      const note = document.createElement('textarea')
      note.className = 'hl-note'
      note.placeholder = 'Add a note or meaning…'
      note.value = h.note
      note.rows = 1
      const grow = () => {
        note.style.height = 'auto'
        note.style.height = `${note.scrollHeight}px`
      }
      note.oninput = () => {
        h.note = note.value
        grow()
        scheduleSave()
      }
      requestAnimationFrame(grow)

      li.append(head, text, note)
      return li
    })
  )
}

function focusSidebarItem(id: string, focusNote: boolean): void {
  document.body.classList.remove('sidebar-closed')
  if (filter !== 'all') {
    filter = 'all'
    syncFilterButtons()
    renderSidebar()
  }
  const li = els.hlList.querySelector<HTMLElement>(`[data-id="${id}"]`)
  if (!li) return
  li.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  li.classList.remove('pulse')
  void li.offsetWidth
  li.classList.add('pulse')
  viewer.flash(id)
  if (focusNote) li.querySelector('textarea')?.focus()
}

$('color-filter').addEventListener('click', (e) => {
  const f = (e.target as HTMLElement).dataset.filter as HighlightColor | 'all' | undefined
  if (!f) return
  filter = f
  syncFilterButtons()
  renderSidebar()
})

function syncFilterButtons(): void {
  for (const b of $('color-filter').querySelectorAll<HTMLElement>('button')) {
    b.classList.toggle('active', b.dataset.filter === filter)
  }
}

// ---------- Export ----------

function toMarkdown(): string {
  if (!ann || !doc) return ''
  const lines = [`# ${ann.title || doc.title}`, '', `_Highlights exported ${new Date().toLocaleString()}_`, '']
  if (doc.kind === 'article') lines.push(`Source: ${doc.path}`, '')
  let lastPage = 0
  for (const h of sortedHighlights()) {
    if (doc.kind !== 'article' && h.page !== lastPage) {
      lines.push(`## Page ${h.page}`, '')
      lastPage = h.page
    }
    lines.push(`> ${h.text}`)
    if (h.note.trim()) lines.push('', ...h.note.trim().split('\n').map((l) => `- ${l}`))
    lines.push('')
  }
  return lines.join('\n')
}

$('btn-export').onclick = async () => {
  if (!ann?.highlights.length) return toast('No highlights to export yet')
  const saved = await api.exportMarkdown(ann.title || doc!.title, toMarkdown())
  if (saved) toast('Exported')
}

// ---------- Library ----------

async function renderLibrary(): Promise<void> {
  const lib = await api.getLibrary()
  els.libEmpty.classList.toggle('hidden', lib.length > 0)
  els.libList.replaceChildren(...lib.map(libItem))
}

function libItem(e: LibraryEntry): HTMLLIElement {
  const li = document.createElement('li')
  const open = document.createElement('button')
  open.className = 'lib-open'
  const t = document.createElement('span')
  t.className = 'lib-title'
  t.textContent = e.title
  const meta = document.createElement('span')
  meta.className = 'muted'
  meta.textContent = `${e.highlightCount} highlight${e.highlightCount === 1 ? '' : 's'} · ${timeAgo(e.lastOpened)}`
  const p = document.createElement('span')
  p.className = 'lib-path muted'
  p.textContent = e.path
  open.append(t, meta, p)
  open.onclick = () => void openPath(e.path)

  const rm = document.createElement('button')
  rm.className = 'icon del'
  rm.title = 'Remove from list (highlights are kept)'
  rm.textContent = '×'
  rm.onclick = async () => {
    await api.removeFromLibrary(e.docId)
    void renderLibrary()
  }
  li.append(open, rm)
  return li
}

function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
  return new Date(ts).toLocaleDateString()
}

// ---------- Toolbar, zoom, theme ----------

function updateZoomLabel(): void {
  els.zoomCurrent.textContent = `${Math.round(viewer.scale * 100)}%`
  els.zoomSelect.value = 'current'
  scheduleSave()
}

function zoomBy(factor: number): void {
  viewer.setScale(viewer.scale * factor)
  updateZoomLabel()
}

const openDialog = async () => openDoc(await api.openDialog())
$('btn-open').onclick = openDialog
$('btn-open-big').onclick = openDialog
$('btn-article').onclick = askArticleUrl
$('btn-article-big').onclick = askArticleUrl
$('btn-home').onclick = () => void goHome()
$('btn-zoom-in').onclick = () => zoomBy(1.15)
$('btn-zoom-out').onclick = () => zoomBy(1 / 1.15)
function applyZoomChoice(choice: string): void {
  if (choice === 'page') viewer.fitPage?.()
  else if (choice === 'width') viewer.fitWidth()
  else if (choice !== 'current') viewer.setScale(Number(choice))
  updateZoomLabel()
}
els.zoomSelect.onchange = () => {
  applyZoomChoice(els.zoomSelect.value)
  els.zoomSelect.blur() // so keyboard shortcuts work again straight away
}
$('btn-sidebar').onclick = () => document.body.classList.toggle('sidebar-closed')
$('btn-chapters').onclick = () => {
  $('btn-chapters').classList.toggle('active', document.body.classList.toggle('chapters-open'))
}

els.pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    viewer.goToPage(parseInt(els.pageInput.value, 10) || 1)
    els.pageInput.blur()
  }
})

els.scroller.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08)
}, { passive: false })

function applyTheme(t: string): void {
  document.body.dataset.theme = t
  els.theme.value = t
}
els.theme.onchange = () => {
  applyTheme(els.theme.value)
  void api.setTheme(els.theme.value)
  if (els.theme.value === 'black') setInvert(true) // black chrome is meant for black pages
}

function applyInvert(on: boolean): void {
  document.body.classList.toggle('inverted', on)
  $('btn-invert').classList.toggle('active', on)
}
function setInvert(on: boolean): void {
  applyInvert(on)
  void api.setInvert(on)
}
$('btn-invert').onclick = () => setInvert(!document.body.classList.contains('inverted'))

// ---------- Keyboard ----------

document.addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement).matches('input, textarea, select')
  const mod = e.ctrlKey || e.metaKey

  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault()
    if (e.shiftKey) askArticleUrl()
    else void openDialog()
    return
  }
  if (mod && e.key.toLowerCase() === 'i') {
    e.preventDefault()
    $('btn-invert').click()
    return
  }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault()
    cycleTab(e.shiftKey ? -1 : 1)
    return
  }
  if (!doc) return

  if (mod && e.key.toLowerCase() === 'w') {
    e.preventDefault()
    if (activeTab) void closeTab(activeTab)
    return
  }

  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.15); return }
  if (mod && e.key === '-') { e.preventDefault(); zoomBy(1 / 1.15); return }
  if (mod && e.key === '0') { e.preventDefault(); applyZoomChoice('width'); return }
  if (mod && e.key === '9') { e.preventDefault(); applyZoomChoice('page'); return }
  if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); $('btn-chapters').click(); return }
  if (mod && e.key.toLowerCase() === 'h') { e.preventDefault(); $('btn-marks').click(); return }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); $('btn-sidebar').click(); return }
  if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); $('btn-home').click(); return }
  if (typing || document.querySelector('dialog[open]')) return

  if (currentRange()) {
    if (!mod && e.key.toLowerCase() === 'e') { e.preventDefault(); explainSelection(); return }
    const i = ['1', '2', '3', '4'].indexOf(e.key)
    if (i >= 0) { e.preventDefault(); createHighlight(COLORS[i]); return }
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); addNoteHighlight(); return }
    if (!mod && e.key.toLowerCase() === 'h') { e.preventDefault(); toggleNextMark('fill'); return }
    if (!mod && e.key.toLowerCase() === 'u') { e.preventDefault(); toggleNextMark('underline'); return }
  }
  if (e.key === 'Escape') {
    window.getSelection()?.removeAllRanges()
    hideSelBar()
  }
  if (doc.kind === 'article') {
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      els.scroller.scrollBy({ top: (e.key === 'PageDown' ? 0.9 : -0.9) * els.scroller.clientHeight })
    }
    return
  }
  if (e.key === 'PageDown' || e.key === 'ArrowRight') {
    e.preventDefault(); viewer.goToPage(viewer.currentPage() + 1)
  }
  if (e.key === 'PageUp' || e.key === 'ArrowLeft') {
    e.preventDefault(); viewer.goToPage(viewer.currentPage() - 1)
  }
})

// ---------- Drag & drop, file association ----------

document.addEventListener('dragover', (e) => {
  e.preventDefault()
  document.body.classList.add('dragging')
})
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging')
})
document.addEventListener('drop', (e) => {
  e.preventDefault()
  document.body.classList.remove('dragging')
  const data = e.dataTransfer
  if (!data) return
  // Links first: a link dragged from a browser can also arrive with a shortcut file attached.
  const link = data.getData('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#'))
  if (link && openFromText(link)) return
  const file = data.files[0]
  if (file) return openFile(file)
  openFromText(data.getData('text/plain'))
})

function openFile(file: File): void {
  if (!file.name.toLowerCase().endsWith('.pdf')) return toast('Only PDF files and links for now')
  void openPath(api.pathForFile(file))
}

/** Open a pasted or dropped web link or PDF path. Returns false if the text is neither. */
function openFromText(raw: string): boolean {
  const text = raw.trim().replace(/^"(.*)"$/, '$1')
  if (/^(https?:\/\/|www\.)\S+$/i.test(text)) {
    void openArticle(text)
    return true
  }
  if (/^([a-z]:[\\/]|\\\\).*\.pdf$/i.test(text)) {
    void openPath(text)
    return true
  }
  return false
}

document.addEventListener('paste', (e) => {
  if ((e.target as HTMLElement).matches('input, textarea, select')) return
  const data = e.clipboardData
  if (!data) return
  if (openFromText(data.getData('text/plain'))) return
  if (data.files[0]) openFile(data.files[0])
})

api.onOpenFile((p) => void openPath(p))

// ---------- Toast ----------

let toastTimer: number | undefined
function toast(msg: string): void {
  els.toast.textContent = msg
  els.toast.classList.remove('hidden')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => els.toast.classList.add('hidden'), 2200)
}

// ---------- Boot ----------

showView('library')
initAi()
void api.getTheme().then(applyTheme)
void api.getInvert().then(applyInvert)
