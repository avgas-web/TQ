import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// base — путь относительно домена GitHub Pages (https://<user>.github.io/<repo>/).
// Без него assets запрашиваются от корня домена и сайт на GitHub Pages не открывается (белый экран / 404).
export default defineConfig(() => ({
  // относительные пути работают и на GitHub Pages (<user>.github.io/<repo>/),
  // и при локальном preview, и при открытии dist/index.html напрямую
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    // ── PWA (ЭТАП 1.3): офлайн-загрузка приложения и кэшированных карт ──
    // Стратегия: CacheFirst для ассетов билда, worker-чанков, WASM и тайловых
    // CDN (карты уже загружались — в поле работаем без интернета);
    // NetworkFirst для навигации (свежий index.html, офлайн — рендер из кэша).
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "TotalQuadro TQ — тактический планировщик",
        short_name: "TQ Tactical",
        description: "Тактическая система управления: карты GeoTIFF/MBTiles, маршруты, офлайн-режим",
        lang: "ru",
        start_url: ".",
        scope: ".",
        display: "standalone",
        background_color: "#111827",
        theme_color: "#111827",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2,wasm}"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Навигация: свежая версия, при отсутствии сети — закешированный shell
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "tq-navigation",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            // Тайловые CDN подложек (Esri/OSM-зеркала/Topo/Google/Яндекс) — CacheFirst
            urlPattern: /\/(ArcGIS|vt\/lyrs|webmap|tile|tiles|osmfr|hot|gde|cyclosm)[@/]/i,
            handler: "CacheFirst",
            options: {
              cacheName: "tq-map-tiles",
              expiration: { maxEntries: 8000, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Geocoding/API — NetworkFirst: данные должны быть свежими, офлайн — кэш
            urlPattern: /\/(geocode|nominatim|search|overpass|elevation)/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "tq-api",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    hmr: {
      port: 3000,
    },
  },
  // Юнит-тесты (Vitest): математика координат, батчи высот, парсеры тактических карт
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // тесты Nominatim проходят реальные паузы очереди/ретраев (1s + round delay)
    testTimeout: 20000,
  },
}));
