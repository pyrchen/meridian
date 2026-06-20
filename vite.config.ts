import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'node:path'

// On GitHub Pages the site is served from https://<user>.github.io/<repo>/.
// Override with BASE_PATH env (e.g. '/' for Cloudflare Pages / custom domain).
const base = process.env.BASE_PATH ?? '/meridian/'

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        arbitrage: resolve(__dirname, 'arbitrage.html'),
        signals: resolve(__dirname, 'signals.html'),
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Meridian — утренний дайджест',
        short_name: 'Meridian',
        description:
          'Самые значимые новости мира: крипта, ИИ, разработка, бизнес. Без логина, читай утром офлайн.',
        lang: 'ru',
        theme_color: '#0b0e14',
        background_color: '#0b0e14',
        display: 'standalone',
        orientation: 'portrait-primary',
        categories: ['news', 'finance', 'productivity'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Keep the last fetched digest available offline for the morning read.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('/data/news.json'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'meridian-news',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 3 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith('/data/signals.json'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'meridian-signals',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // шрифты Google кэшируем, чтобы офлайн-вид не «ломался»
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-css' },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
})
