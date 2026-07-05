import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Second entry alongside the default src/main/index.ts -- bundles the
        // pure-Node input-helper (see src/input-helper/index.ts) to
        // out/main/input-helper.js, next to out/main/index.js. It's spawned
        // by inputHelperHost.ts at runtime, not loaded by the main process
        // itself, but shares the same build target (Node platform, native
        // deps externalized) so it needs no separate build step.
        input: {
          index: resolve('src/main/index.ts'),
          'input-helper': resolve('src/input-helper/index.ts')
        }
      }
    }
  },
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
