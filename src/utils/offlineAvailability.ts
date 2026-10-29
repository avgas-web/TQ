// ═══════════════════════════════════════════════════════════════
// offlineAvailability — ЭТАП 1.3: проверка возможностей офлайн-режима.
// Если браузер/окружение не поддерживает Service Worker или Cache API
// (http без TLS, приватный режим Firefox, старые WebView) — приложение
// ОБЯЗАНО работать дальше и показать понятную причину, а не крашиться.
// ═══════════════════════════════════════════════════════════════

export interface OfflineCapability {
  serviceWorkerSupported: boolean;
  cacheApiSupported: boolean;
  secureContext: boolean;
  /** Причина недоступности офлайна (для UI); null — всё в порядке */
  blocker: string | null;
}

export function detectOfflineCapability(): OfflineCapability {
  const hasSW = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const hasCaches = typeof caches !== 'undefined' && !!caches && 'open' in caches;
  const secure = typeof window !== 'undefined' ? !!(window.isSecureContext ?? isLocalhost()) : false;
  let blocker: string | null = null;
  if (!hasSW) {
    blocker = 'Браузер не поддерживает Service Worker — полностью офлайн-режим недоступен. Данные проекта по-прежнему сохраняются локально.';
  } else if (!secure) {
    blocker = 'Офлайн-кэш требует защищённого контекста (HTTPS или localhost). Откройте приложение по HTTPS.';
  } else if (!hasCaches) {
    blocker = 'Cache API недоступен (приватный режим?) — офлайн-тайлы не кэшируются.';
  }
  return { serviceWorkerSupported: hasSW, cacheApiSupported: hasCaches, secureContext: secure, blocker };
}

function isLocalhost(): boolean {
  try {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '';
  } catch {
    return false;
  }
}
