import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    // Lets multiple app instances (agent + controller) run concurrently on
    // one machine for local testing, each on its own dev server port.
    server: {
      port: Number(process.env.RENDERER_PORT) || 5173
    }
  }
})
