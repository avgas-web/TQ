// ВАЖНО: defineConfig берём из "vite", а НЕ из "vitest/config".
// vitest/config — это отдельная CJS-сборка Vite, и при её использовании CLI
// `vite build` подхватывает дефолты другой копии vite (worker.format:"iife"),
// из-за чего падал с ошибкой:
//   Invalid value "iife" for option "worker.format" - UMD and IIFE output
//   formats are not supported for code-splitting builds.
// Секция `test` ниже валидна и для vite-типов (vitest читает её из этого же файла).
import { defineConfig } from "vite";
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
    // ─── ЭТАП 1.3: PWA для полевых условий (полный офлайн) ───
    // Стратегия кэширования:
    //  • Precache + CacheFirst — все JS/CSS ассембли бандла (скрипты, стили);
    //  • CacheFirst — ранее загруженные тайлы базовых карт (OSM/GDELT) и иконки;
    //  • NetworkFirst (+ fallback в кэш) — API-запросы (Nominatim, высоты, routing).
    // base остаётся "./" (GitHub Pages): SW регистрируется с относительным scope,
    // поэтому деплой на поддомен/подпапку не ломается.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "TotalQuadro Coordinate Marker",
        short_name: "TotalQuadro",
        description: "Тактическая система координатного маркера и планирования маршрутов (офлайн-capable PWA)",
        theme_color: "#111827",
        background_color: "#111827",
        display: "standalone",
        // относительные поля — совместимо с base:"./" и GitHub Pages /<repo>/
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Тайлы базовых карт: CacheFirst — прилетевшие один раз тайлы
            // остаются в кэше и отдаются полностью офлайн.
            urlPattern: /^https:\/\/[a-z]\.tile\.openstreetmap\.org\//,
            handler: "CacheFirst",
            options: {
              cacheName: "osm-tiles",
              expiration: { maxEntries: 8000, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/[a-z]+\.basemaps\.gdeltdc\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "gde-tiles",
              expiration: { maxEntries: 8000, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // API (геокодер, высоты, метео): NetworkFirst со свежим ответом,
            // но при отсутствии сети — из кэша (последний известный ответ).
            urlPattern: /\/api\/|nominatim\.openstreetmap\.org|api\.open-meteo\.com/,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-cache",
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false }, // SW в dev-режиме мешает HMR; включается явно при отладке офлайна
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
  // ЭТАП 1.1: mapParsers.worker использует динамические import('geotiff'/'sql.js')
  // → воркер требует ES-формата (IIFE/UMD не поддерживают code-splitting).
  // ВАЖНО: vite@6 читает worker.format ТОЛЬКО из КОРНЯ конфига; вариант
  // `build.worker.format` молча игнорируется (проверено на vite@6.4.5),
  // и сборка падала: Invalid value "iife" for option "worker.format".
  worker: { format: "es" },
  build: {},
  // Юнит-тесты (Vitest): математика координат, батчи высот, парсеры тактических карт
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // тесты Nominatim проходят реальные паузы очереди/ретраев (1s + round delay)
    testTimeout: 20000,
  },
}));
