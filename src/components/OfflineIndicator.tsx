// ═══════════════════════════════════════════════════════════════
// OfflineIndicator — ЭТАП 1.3: бейдж статуса сети + офлайн-возможностей.
// Показывает: онлайн/офлайн, «приложение готово к работе без сети», либо
// понятную причину почему офлайн недоступен (graceful degradation).
// Никаких крашей: все API проверяются через detectOfflineCapability().
// ═══════════════════════════════════════════════════════════════
import React, { useEffect, useState } from 'react';
import { detectOfflineCapability, type OfflineCapability } from '../utils/offlineAvailability';

export const OfflineIndicator: React.FC = () => {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [cap, setCap] = useState<OfflineCapability | null>(null);

  useEffect(() => {
    setCap(detectOfflineCapability());
    const on = (): void => setOnline(true);
    const off = (): void => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const offlineReady = !!cap && !cap.blocker;

  return (
    <div className="flex items-center gap-2" data-testid="offline-indicator">
      <span
        title={online ? 'Сеть доступна' : 'Нет сети — работаем из кэша'}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${
          online ? 'bg-green-900/60 text-green-300' : 'bg-red-900/70 text-red-200'
        }`}
      >
        <span aria-hidden>{online ? '🛰️' : '📴'}</span>
        {online ? 'Онлайн' : 'Офлайн'}
      </span>
      {cap?.blocker ? (
        <span
          role="alert"
          data-testid="offline-blocker"
          className="text-[10px] text-amber-400 max-w-[220px]"
          title={cap.blocker}
        >⚠ Офлайн-режим: {cap.blocker}</span>
      ) : offlineReady ? (
        <span className="text-[10px] text-gray-400" title="Контент и тайлы кэшируются — приложение работает полностью офлайн">
          ⬇ Готов к офлайну
        </span>
      ) : null}
    </div>
  );
};

export default OfflineIndicator;
