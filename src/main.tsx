import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary.tsx";

// Экран с текстом ошибки вместо «белого листа» при сбое загрузки/рендера
function showError(title: string, detail: unknown) {
  const pre = document.createElement("pre");
  pre.style.cssText =
    "padding:2rem;font-family:monospace;color:#b00020;background:#fff;white-space:pre-wrap;margin:0;min-height:100vh";
  pre.textContent = `${title}\n\n${
    detail instanceof Error ? detail.stack || detail.message : String(detail)
  }`;
  const rootEl = document.getElementById("root");
  if (rootEl) {
    rootEl.replaceChildren(pre);
  } else {
    document.body.appendChild(pre);
  }
}

// Независимо от того, какой скрипт упадёт (наш бандл или внешний CDN),
// пользователь увидит текст ошибки, а не пустую страницу.
window.addEventListener("unhandledrejection", (e) => {
  console.error("Необработанная промис-ошибка:", e.reason);
});

const rootEl = document.getElementById("root");

if (!rootEl) {
  showError("Не найден элемент #root. Проверьте index.html.", "");
} else {
  try {
    // AppErrorBoundary (src/components/AppErrorBoundary.tsx): диагностика краша,
    // кнопки «Продолжить» и «Сбросить данные» (очистка tq-map/tq-mission/tq-fleet).
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </React.StrictMode>
    );
  } catch (err) {
    showError("Ошибка запуска приложения:", err);
  }
}
