// ═══════════════════════════════════════════════════════════════
// Типизация окружения Vite + virtual:pwa-register (vite-plugin-pwa).
// Строгий режим: никаких any — только типизированные Record'ы.
// ═══════════════════════════════════════════════════════════════
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  readonly VITE_YANDEX_MAPS_API_KEY?: string;
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly MODE?: string;
  readonly BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'virtual:pwa-register' {
  export interface RegisterOptions {
    immediate?: boolean;
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: unknown) => void;
  }
  /** Возвращает функцию обновления SW; false — обновление не требуется/недоступно. */
  export function registerSW(config?: RegisterOptions): Promise<boolean>;
}
