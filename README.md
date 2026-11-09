# Pypr

_paper + papyrus_ — a lightweight Windows reader for research papers. Electron + TypeScript + pdf.js, no UI framework.

## Run

```bash
npm install        # also copies pdf.js fonts/cmaps/wasm into src/renderer/public/pdfjs
npm run dev        # dev mode with hot reload
npm run dist       # builds a Windows installer into release/
```

## Using it

- **Open:** `Ctrl+O`, drag or paste a PDF or a link onto the window, or pick from Recent. Links to PDFs open as PDFs. After installing, PDFs can be opened with "Open with → Pypr".
- **Articles:** "Article" or `Ctrl+Shift+O`, then paste a link. It opens in a clean reading view with all the same tools, and a copy is saved so it also works offline.
- **Tabs:** every paper or article opens in its own tab and remembers its place. `Ctrl+Tab` / `Ctrl+Shift+Tab` to switch, `Ctrl+W` or middle-click to close, `+` to open another.
- **Highlight:** select text → click a color, or press `1` yellow · `2` green · `3` blue · `4` pink.
- **Underline:** the `H` and `U` toggles (or keys) on the selection bar choose highlight, underline, or both, then pick a color. They stay set for the next selection, and each sidebar item has its own `H` / `U`.
- **Chapters:** "Chapters" or `Ctrl+T` shows or hides the left panel. PDFs use their table of contents, articles use their headings.
- **AI Explanations:** in the title bar, pick Claude, ChatGPT, Gemini, Groq, Grok or any OpenAI-compatible link, and add your API key. Leave the model empty to use the provider's latest. Then select text and press `E` or "Explain". Keys are encrypted with Windows secure storage, and selected text is sent only to the provider you choose.
- **Clean read:** "Hide marks" or `Ctrl+H` hides all highlights and underlines without deleting them. Press again to bring them back.
- **Highlight + note:** select text → `N` (or "Note"). The note box in the sidebar gets focus — use it for meanings, doubts, anything.
- **Sidebar** (`Ctrl+B`): click a quote to jump to it, click the dot to change color, filter by color, `×` to delete. Clicking a highlight in the page selects it in the sidebar.
- **Zoom:** `Ctrl+=` / `Ctrl+-`, `Ctrl+wheel`, `Ctrl+0` fit width, `Ctrl+9` fit page, or pick a level from the zoom menu. **Pages:** `PageUp`/`PageDown`, or type in the page box.
- **Export:** "Export" writes all highlights + notes to a Markdown file, grouped by page.
- **Themes:** Light / Sepia / Solarized / Dark / Nord / Black.
- **Invert:** `Ctrl+I` or the "Invert" button turns pages to a black background with white text, on any theme.
- **Library:** `Ctrl+L`.

## How data is stored

Everything is local, in `%APPDATA%/Pypr/`:

- `annotations/<sha256>.json` — highlights, notes, last page and zoom for one paper
- `articles/<sha256 of URL>.html` — saved reading-view copy of each article
- `library.json` — recent papers and articles
- `settings.json` — theme and invert

A paper's identity is the SHA-256 of its bytes, not its path. So renaming, moving, or re-downloading the same PDF keeps all its highlights.

Highlights are stored as rectangles in PDF page units (zoom-independent) plus the selected text, so they line up at any zoom level.

## Code map

| File | What it does |
| --- | --- |
| `src/main/index.ts` | Window, file open/hash, JSON storage (atomic writes), single-instance + file association |
| `src/preload/index.ts` | Safe `window.reader` API (context isolation + sandbox on) |
| `src/renderer/src/viewer.ts` | pdf.js rendering: canvas + text layer, lazy render/unrender, zoom with anchor |
| `src/renderer/src/geometry.ts` | Selection → per-page highlight rects, line merging, clean text extraction |
| `src/renderer/src/main.ts` | UI: toolbar, selection bar, sidebar, library, shortcuts, export |
| `src/shared/types.ts` | Shared types |

## Next ideas

- Search inside the paper (`Ctrl+F`)
- Dictionary lookup for a selected word, saved into the note
- Backup of the annotations folder to Google Drive
