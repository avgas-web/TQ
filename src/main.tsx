import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// Экран с текстом ошибки вместо «белого листа» при сбое загрузки/рендера
function showError(title: string, detail: unknown) {
  const pre = document.createElement("pre");
  pre.style.cssText =
    "padding:2rem;font-family:monospace;color:#b00020;background:#fff;white-space:pre-wrap;margin:0;min-height:100vh";
  pre.textContent = `${title}\n\n${
    detail instanceof Error ? detail.stack || detail.message : String(detail)
  }`;
  document.getElementById("root")?.replaceChildren(pre) ??
    document.body.appendChild(pre);
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
    // Error Boundary: ошибки внутри React-дерева не дают белый экран
    class ErrorBoundary extends React.Component<
      { children: React.ReactNode },
      { error: Error | null }
    > {
      state = { error: null as Error | null };
      static getDerivedStateFromError(error: Error) {
        return { error };
      }
      componentDidCatch(error: Error) {
        console.error("Ошибка рендера React:", error);
      }
      render() {
        if (this.state.error) {
          return (
            <pre
              style={{
                padding: "2rem",
                fontFamily: "monospace",
                color: "#b00020",
                background: "#fff",
                whiteSpace: "pre-wrap",
                minHeight: "100vh",
              }}
            >
              {`Ошибка приложения:\n\n${this.state.error.stack || this.state.error.message}`}
            </pre>
          );
        }
        return this.props.children;
      }
    }

    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (err) {
    showError("Ошибка запуска приложения:", err);
  }
}
