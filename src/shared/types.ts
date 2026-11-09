export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink'

/** Rect in PDF page units at scale 1 (independent of zoom). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Highlight {
  id: string
  page: number // 1-based
  rects: Rect[]
  text: string
  color: HighlightColor
  fill?: boolean // colored background; missing means true (older saved highlights)
  underline?: boolean
  start?: number // articles only: character offsets into the article text
  end?: number
  note: string
  createdAt: number
}

export interface DocAnnotations {
  docId: string // sha256 of file bytes
  title: string
  highlights: Highlight[]
  lastPage: number
  zoom: number
  scrollFrac?: number // articles only: reading position, 0 to 1
}

export interface LibraryEntry {
  docId: string
  path: string
  title: string
  lastOpened: number
  highlightCount: number
}

export interface OpenedDoc {
  docId: string
  path: string
  title: string
  data: Uint8Array // empty for articles
  kind?: 'article'
  html?: string // articles only: the saved reading-view copy
  annotations: DocAnnotations
}

export type FetchedUrl = { kind: 'html'; html: string } | { kind: 'pdf'; doc: OpenedDoc }

export interface AiProviderView {
  id: string
  name: string
  baseUrl: string
  model: string // empty means use the provider's latest
  keyUrl: string
  hasKey: boolean
}

export interface AiSettings {
  active: string
  providers: AiProviderView[]
}

export interface AiProviderInput {
  baseUrl: string
  model: string
  key: string // empty keeps the saved key
}

export type AiResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface ReaderApi {
  openDialog(): Promise<OpenedDoc | null>
  openPath(path: string): Promise<OpenedDoc | null>
  openSavedArticle(url: string): Promise<OpenedDoc | null>
  fetchUrl(url: string): Promise<FetchedUrl | null>
  aiGetSettings(): Promise<AiSettings>
  aiSaveProvider(id: string, input: AiProviderInput): Promise<string | null> // error message, if any
  aiListModels(id: string): Promise<AiResult<string[]>>
  aiExplain(text: string, title: string): Promise<AiResult<string>>
  saveArticle(url: string, title: string, html: string): Promise<OpenedDoc | null>
  saveAnnotations(a: DocAnnotations): Promise<void>
  getLibrary(): Promise<LibraryEntry[]>
  removeFromLibrary(docId: string): Promise<void>
  exportMarkdown(title: string, markdown: string): Promise<string | null>
  getTheme(): Promise<string>
  setTheme(theme: string): Promise<void>
  getInvert(): Promise<boolean>
  setInvert(on: boolean): Promise<void>
  onOpenFile(cb: (path: string) => void): void
  onBeforeClose(cb: () => void): void
  closeReady(): void
  pathForFile(file: File): string
}
