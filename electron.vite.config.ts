import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: { target: 'esnext' } // pdf.js uses top-level await / modern syntax
  }
})
