import type { AiSettings } from '../../shared/types'

const api = window.reader
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

let settings: AiSettings | null = null
let explainRun = 0

const fields = {
  provider: $<HTMLSelectElement>('ai-provider'),
  baseUrl: $<HTMLInputElement>('ai-base-url'),
  key: $<HTMLInputElement>('ai-key'),
  model: $<HTMLInputElement>('ai-model'),
  models: $<HTMLDataListElement>('ai-models'),
  status: $('ai-status')
}

function showProvider(): void {
  const p = settings?.providers.find((x) => x.id === fields.provider.value)
  if (!p) return
  fields.baseUrl.value = p.baseUrl
  fields.model.value = p.model
  fields.key.value = ''
  fields.key.placeholder = p.hasKey ? 'Saved. Paste a new key to replace it.' : 'Paste your API key'
  fields.models.replaceChildren()
  fields.status.textContent = ''
}

async function openSettings(): Promise<void> {
  settings = await api.aiGetSettings()
  fields.provider.replaceChildren(...settings.providers.map((p) => new Option(p.name, p.id)))
  fields.provider.value = settings.active
  $('ai-key-links').replaceChildren(
    ...settings.providers
      .filter((p) => p.keyUrl)
      .map((p) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = p.name.split(' (')[0]
        b.title = `Get an API key: ${p.keyUrl}`
        b.onclick = () => window.open(p.keyUrl, '_blank') // main process sends it to the real browser
        return b
      })
  )
  showProvider()
  $<HTMLDialogElement>('ai-dialog').showModal()
}

async function save(): Promise<boolean> {
  const id = fields.provider.value
  const error = await api.aiSaveProvider(id, {
    baseUrl: fields.baseUrl.value,
    model: fields.model.value,
    key: fields.key.value
  })
  if (error) {
    fields.status.textContent = error
    return false
  }
  settings = await api.aiGetSettings()
  showProviderAfterSave(id)
  return true
}

function showProviderAfterSave(id: string): void {
  fields.provider.value = id
  showProvider()
  fields.status.textContent = 'Saved.'
}

async function loadModels(): Promise<void> {
  if (!(await save())) return
  fields.status.textContent = 'Loading models…'
  const res = await api.aiListModels(fields.provider.value)
  if (!res.ok) {
    fields.status.textContent = res.error
    return
  }
  fields.models.replaceChildren(...res.value.map((id) => new Option(id, id)))
  fields.status.textContent = res.value.length
    ? `${res.value.length} models found. Latest: ${res.value[0]}`
    : 'No models found.'
}

export function initAi(): void {
  $('btn-ai').onclick = () => void openSettings()
  fields.provider.onchange = showProvider
  $('ai-save').onclick = () => void save()
  $('ai-load-models').onclick = () => void loadModels()
}

/** Ask the chosen AI about `text`. `onSave` receives the answer if the user keeps it as a note. */
export async function explain(text: string, title: string, onSave: (answer: string) => void): Promise<void> {
  const dialog = $<HTMLDialogElement>('explain-dialog')
  const result = $('explain-result')
  const saveBtn = $('explain-save')
  const run = ++explainRun
  $('explain-quote').textContent = text
  result.textContent = 'Thinking…'
  saveBtn.classList.add('hidden')
  dialog.showModal()

  const res = await api.aiExplain(text, title)
  if (run !== explainRun) return
  result.textContent = res.ok ? res.value : res.error
  if (!res.ok) return
  saveBtn.classList.remove('hidden')
  saveBtn.onclick = () => {
    dialog.close()
    onSave(res.value)
  }
}
