/// <reference types="vite/client" />

// ─── ЭТАП 1.2: строгая типизация переменных окружения (.env / import.meta.env) ───
interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  readonly VITE_YANDEX_MAPS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// ─── ЭТАП 1.3: виртуальный модуль vite-plugin-pwa (может отсутствовать в сборке без плагина —
// импорт обёрнут в try/catch в src/utils/swRegistration.ts) ───
declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegisteredSW?: (swScriptUrl: string | undefined, registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: unknown) => void;
  }
  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
