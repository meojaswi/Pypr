import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DocAnnotations, ReaderApi } from '../shared/types'

const api: ReaderApi = {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  openPath: (p: string) => ipcRenderer.invoke('open-path', p),
  openSavedArticle: (url: string) => ipcRenderer.invoke('open-saved-article', url),
  fetchUrl: (url: string) => ipcRenderer.invoke('fetch-url', url),
  aiGetSettings: () => ipcRenderer.invoke('ai-get-settings'),
  aiSaveProvider: (id, input) => ipcRenderer.invoke('ai-save-provider', id, input),
  aiListModels: (id) => ipcRenderer.invoke('ai-list-models', id),
  aiExplain: (text, title) => ipcRenderer.invoke('ai-explain', text, title),
  saveArticle: (url: string, title: string, html: string) => ipcRenderer.invoke('save-article', url, title, html),
  saveAnnotations: (a: DocAnnotations) => ipcRenderer.invoke('save-annotations', a),
  getLibrary: () => ipcRenderer.invoke('get-library'),
  removeFromLibrary: (id: string) => ipcRenderer.invoke('remove-from-library', id),
  exportMarkdown: (title: string, md: string) => ipcRenderer.invoke('export-markdown', title, md),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (t: string) => ipcRenderer.invoke('set-theme', t),
  getInvert: () => ipcRenderer.invoke('get-invert'),
  setInvert: (on: boolean) => ipcRenderer.invoke('set-invert', on),
  onOpenFile: (cb) => {
    ipcRenderer.on('open-file', (_e, p: string) => cb(p))
  },
  onBeforeClose: (cb) => {
    ipcRenderer.on('before-close', () => cb())
  },
  closeReady: () => ipcRenderer.send('close-ready'),
  pathForFile: (file: File) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('reader', api)
