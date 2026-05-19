/**
 * Vite + React + Electron（vite-plugin-electron）一体化构建配置。
 * Bundles renderer (`dist/`), main (`dist-electron/main.js`), and preload entrypoints.
 */

import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

// Vite 配置文件入口 / Vite config entry — https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // 等价于 `build.lib.entry` / Shortcut for `build.lib.entry`.
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['@anthropic-ai/claude-agent-sdk', 'electron-updater'],
            },
          },
        },
      },
      preload: {
        // 等价于 `build.rollupOptions.input`；preload 可走 Web 资源用法 /
        // Shortcut for `build.rollupOptions.input` (preload may bundle web assets, unlike plain lib entry).
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      // 为渲染进程补齐 Electron/Node API 垫片；若要在渲染进程直接用 Node，需在主进程开启 `nodeIntegration` /
      // Polyfill Electron + Node APIs for the renderer; enabling raw Node in renderer requires `nodeIntegration` in main.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === 'test'
        // 测试环境下关闭 renderer 插件（避免已知兼容问题）/
        // Tests: disable renderer helper — https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        ? undefined
        : {},
    }),
  ],
})
