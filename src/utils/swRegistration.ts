// ═══════════════════════════════════════════════════════════════
// swRegistration — ЭТАП 1.3: безопасная регистрация Service Worker (PWA).
// Работает через virtual:pwa-register (vite-plugin-pwa). При отсутствии
// поддержки SW/в небезопасном контексте — НЕ кидается, а возвращает
// причину в callback для UI-баннера (см. OfflineIndicator).
// ═══════════════════════════════════════════════════════════════
import { detectOfflineCapability } from './offlineAvailability';

export interface SwRegistrationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Регистрирует SW. Идемпотентна; вызывается один раз из main.tsx.
 * @param onUpdateNotify колбэк «доступна новая версия офлайн-кэша»
 */
export async function registerServiceWorker(
  onUpdateNotify?: (message: string) => void,
): Promise<SwRegistrationResult> {
  const cap = detectOfflineCapability();
  if (cap.blocker) return { ok: false, reason: cap.blocker };
  try {
    // Виртуальный модуль создаётся vite-plugin-pwa при сборке. Динамический
    // импорт + try/catch: при запуске без сборки плагина (тесты/dev без PWA)
    // приложение продолжает работать без офлайн-кэша.
    const mod = await import('virtual:pwa-register' as string).catch(() => null);
    type RegisterFn = (opts: {
      onRegistered?: (r: ServiceWorkerRegistration | undefined) => void;
      onUpdated?: () => void;
    }) => (reloadPage?: boolean) => Promise<void>;
    if (!mod || typeof (mod as { registerSW?: unknown }).registerSW !== 'function') {
      return { ok: false, reason: 'Модуль PWA не встроен в эту сборку — офлайн-кэш отключён.' };
    }
    const registerSW = (mod as { registerSW: RegisterFn }).registerSW({
      onRegistered: (r) => {
        // Периодическая проверка обновлений PRECACHE (полевые условия: редкие перезагрузки вкладок)
        if (r && typeof setInterval === 'function') {
          setInterval(() => { void r.update().catch(() => undefined); }, 60 * 60 * 1000);
        }
      },
      onUpdated: () => {
        onUpdateNotify?.('Доступна новая версия приложения. Обновите страницу для свежих данных.');
      },
    });
    await registerSW(false);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `Не удалось включить офлайн-режим: ${err instanceof Error ? err.message : String(err)}. Приложение работает в обычном режиме.`,
    };
  }
}
