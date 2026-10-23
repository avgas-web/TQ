import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base — путь относительно домена GitHub Pages (https://<user>.github.io/<repo>/).
// Без него assets запрашиваются от корня домена и сайт на GitHub Pages не открывается (белый экран / 404).
export default defineConfig(() => ({
  // относительные пути работают и на GitHub Pages (<user>.github.io/<repo>/),
  // и при локальном preview, и при открытии dist/index.html напрямую
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    // HMR без жёстко зашитого порта/хоста: сокет подключается по фактическому
    // адресу страницы (localhost, IP, туннель/прокси — например, code-server).
    // Раньше hmr.port=3000 ломал hot-reload при доступе не через localhost:3000,
    // и для применения правок приходилось перезагружать редактор вручную (F5).
    hmr: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 3000,
  },
}));
