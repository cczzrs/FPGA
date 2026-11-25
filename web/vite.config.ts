import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      input: ['index.html', 'projects/floorplan/index.html'],
      output: {
        manualChunks(id) {
          if (id.endsWith('/three/build/three.core.js')) return 'three-core'
          if (id.endsWith('/three/build/three.module.js')) return 'three-webgl'
        }
      }
    }
  }
})
