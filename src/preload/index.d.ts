import type { ReaderApi } from '../shared/types'

declare global {
  interface Window {
    reader: ReaderApi
  }
}

export {}
