import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// 相对路径让构建产物可放在任意子目录；three 单独成块，单块约 600 kB。
export default defineConfig({
  base: '/projects/floorplan/',
  root: import.meta.dirname,
  publicDir: resolve(import.meta.dirname, 'public'),
  build: {
    outDir: resolve(import.meta.dirname, '../dist/floorplan'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 750
  },
})
