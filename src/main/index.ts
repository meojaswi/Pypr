import { app, BrowserWindow, dialog, ipcMain, Menu, net, shell } from 'electron'
import { registerAiHandlers } from './ai'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DocAnnotations, FetchedUrl, LibraryEntry, OpenedDoc } from '../shared/types'

let win: BrowserWindow | null = null
let pendingOpenPath: string | null = null

const dataDir = () => app.getPath('userData')
const annDir = () => path.join(dataDir(), 'annotations')
const libraryFile = () => path.join(dataDir(), 'library.json')
const settingsFile = () => path.join(dataDir(), 'settings.json')

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (err) {
    // Keep unreadable JSON aside, so the next save can't erase whatever is recoverable.
    if (err instanceof SyntaxError) await fs.rename(file, `${file}.${Date.now()}.corrupt`).catch(() => {})
    return fallback
  }
}

/** Runs storage jobs one at a time, so read-modify-write cycles can't interleave. */
let storageQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = storageQueue.then(job)
  storageQueue = run.catch(() => {})
  return run
}

/** Write to a temp file, then rename, so a crash never leaves half-written JSON. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

const annFile = (docId: string) => {
  if (!/^[a-f0-9]{64}$/.test(docId)) throw new Error('bad docId')
  return path.join(annDir(), `${docId}.json`)
}

function updateLibrary(entry: LibraryEntry): Promise<void> {
  return enqueue(async () => {
    const lib = await readJson<LibraryEntry[]>(libraryFile(), [])
    const rest = lib.filter((e) => e.docId !== entry.docId)
    await writeJsonAtomic(libraryFile(), [entry, ...rest].slice(0, 200))
  })
}

async function openPdf(filePath: string): Promise<OpenedDoc | null> {
  if (path.extname(filePath).toLowerCase() !== '.pdf') return null
  let buf: Buffer
  try {
    buf = await fs.readFile(filePath)
  } catch {
    return null
  }
  return pdfDoc(buf, filePath, path.basename(filePath, path.extname(filePath)))
}

/** `location` is a file path, or the URL for a PDF that came from a link. */
async function pdfDoc(buf: Buffer, location: string, title: string): Promise<OpenedDoc> {
  // Identity = content hash, so a renamed/re-downloaded copy keeps its highlights.
  const docId = createHash('sha256').update(buf).digest('hex')
  const saved = await enqueue(() =>
    readJson<DocAnnotations>(annFile(docId), { docId, title, highlights: [], lastPage: 1, zoom: 1.25 })
  )
  const annotations = { ...saved, title } // the current filename wins over the one first seen
  await updateLibrary({
    docId,
    path: location,
    title,
    lastOpened: Date.now(),
    highlightCount: annotations.highlights.length
  })
  return { docId, path: location, title, data: new Uint8Array(buf), annotations }
}

// ---- Articles ----
const MAX_ARTICLE_BYTES = 15 * 1024 * 1024

/** http(s) only, without the #fragment, so one article always maps to one id. */
function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

const articleId = (url: string) => createHash('sha256').update(url).digest('hex')
const articleFile = (docId: string) => path.join(dataDir(), 'articles', `${docId}.html`)

async function articleDoc(url: string, html: string, fallbackTitle: string): Promise<OpenedDoc> {
  const docId = articleId(url)
  const annotations = await enqueue(() =>
    readJson<DocAnnotations>(annFile(docId), { docId, title: fallbackTitle, highlights: [], lastPage: 1, zoom: 1 })
  )
  await updateLibrary({
    docId,
    path: url,
    title: annotations.title,
    lastOpened: Date.now(),
    highlightCount: annotations.highlights.length
  })
  return { kind: 'article', docId, path: url, title: annotations.title, data: new Uint8Array(0), html, annotations }
}

ipcMain.handle('open-saved-article', async (_e, raw: string) => {
  const url = normalizeUrl(raw)
  if (!url) return null
  try {
    return await articleDoc(url, await fs.readFile(articleFile(articleId(url)), 'utf8'), url)
  } catch {
    return null
  }
})

ipcMain.handle('fetch-url', async (_e, raw: string): Promise<FetchedUrl | null> => {
  const url = normalizeUrl(raw)
  if (!url) return null
  try {
    const res = await net.fetch(url)
    if (!res.ok) return null
    const body = Buffer.from(await res.arrayBuffer())
    if (body.subarray(0, 5).toString('latin1') === '%PDF-') {
      const name = decodeURIComponent(path.posix.basename(new URL(res.url || url).pathname))
      return { kind: 'pdf', doc: await pdfDoc(body, url, name.replace(/\.pdf$/i, '') || url) }
    }
    if (!/html/i.test(res.headers.get('content-type') ?? '') || body.byteLength > MAX_ARTICLE_BYTES) return null
    return { kind: 'html', html: new TextDecoder().decode(body) }
  } catch {
    return null
  }
})

const aiFile = () => path.join(dataDir(), 'ai.json')
registerAiHandlers({
  read: () => enqueue(() => readJson(aiFile(), {})),
  write: (update) => enqueue(async () => writeJsonAtomic(aiFile(), update(await readJson(aiFile(), {}))))
})

ipcMain.handle('save-article', async (_e, raw: string, title: string, html: string) => {
  const url = normalizeUrl(raw)
  if (!url) return null
  const file = articleFile(articleId(url))
  await enqueue(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, html, 'utf8')
  })
  return articleDoc(url, html, title)
})

function pdfFromArgv(argv: string[]): string | null {
  return argv.slice(1).find((a) => a.toLowerCase().endsWith('.pdf')) ?? null
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 500,
    backgroundColor: '#1b1b1f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win?.show())

  // Let the renderer finish saving before the window goes away.
  const w = win
  let closing = false
  w.on('close', (e) => {
    e.preventDefault()
    if (closing) return
    closing = true
    const done = () => {
      clearTimeout(timer)
      ipcMain.removeListener('close-ready', done)
      if (!w.isDestroyed()) w.destroy()
    }
    const timer = setTimeout(done, 3000) // a hung renderer must not block quitting
    ipcMain.once('close-ready', done)
    w.webContents.send('before-close')
  })

  // Links inside PDFs open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  win.webContents.on('did-finish-load', () => {
    if (pendingOpenPath) {
      win?.webContents.send('open-file', pendingOpenPath)
      pendingOpenPath = null
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

// ---- IPC ----
ipcMain.handle('open-dialog', async () => {
  const res = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (res.canceled || !res.filePaths[0]) return null
  return openPdf(res.filePaths[0])
})

ipcMain.handle('open-path', (_e, p: string) => openPdf(p))

ipcMain.handle('save-annotations', (_e, a: DocAnnotations) =>
  enqueue(async () => {
    await writeJsonAtomic(annFile(a.docId), a)
    const lib = await readJson<LibraryEntry[]>(libraryFile(), [])
    const entry = lib.find((e) => e.docId === a.docId)
    // Page turns also land here; only touch the library when it actually changed.
    if (entry && (entry.highlightCount !== a.highlights.length || entry.title !== a.title)) {
      entry.highlightCount = a.highlights.length
      entry.title = a.title
      await writeJsonAtomic(libraryFile(), lib)
    }
  })
)

ipcMain.handle('get-library', () => readJson<LibraryEntry[]>(libraryFile(), []))

ipcMain.handle('remove-from-library', (_e, docId: string) =>
  enqueue(async () => {
    const lib = await readJson<LibraryEntry[]>(libraryFile(), [])
    await writeJsonAtomic(libraryFile(), lib.filter((e) => e.docId !== docId))
  })
)

ipcMain.handle('export-markdown', async (_e, title: string, md: string) => {
  const res = await dialog.showSaveDialog(win!, {
    defaultPath: `${title.replace(/[\\/:*?"<>|]/g, '_')} - highlights.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (res.canceled || !res.filePath) return null
  await fs.writeFile(res.filePath, md, 'utf8')
  return res.filePath
})

ipcMain.handle('get-theme', async () => (await readJson(settingsFile(), { theme: 'dark' })).theme)
ipcMain.handle('set-theme', (_e, theme: string) =>
  enqueue(async () => {
    const s = await readJson<Record<string, unknown>>(settingsFile(), {})
    await writeJsonAtomic(settingsFile(), { ...s, theme })
  })
)

ipcMain.handle('get-invert', async () => (await readJson(settingsFile(), { invert: false })).invert === true)
ipcMain.handle('set-invert', (_e, invert: boolean) =>
  enqueue(async () => {
    const s = await readJson<Record<string, unknown>>(settingsFile(), {})
    await writeJsonAtomic(settingsFile(), { ...s, invert })
  })
)

// ---- App lifecycle ----
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Double-clicking a PDF while the app is open → open it in the existing window.
  app.on('second-instance', (_e, argv) => {
    const p = pdfFromArgv(argv)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
      if (p) win.webContents.send('open-file', p)
    }
  })

  pendingOpenPath = pdfFromArgv(process.argv)
  Menu.setApplicationMenu(null) // the default menu's Ctrl+W would close the whole app, not a tab
  app.whenReady().then(createWindow)
  app.on('window-all-closed', () => app.quit())
}
