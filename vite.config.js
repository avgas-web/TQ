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
    hmr: {
      port: 3000,
    },
  },
}));
