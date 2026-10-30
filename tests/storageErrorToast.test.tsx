// ═══════════════════════════════════════════════════════════════
// ФАЗА 4.1 (аудит): ошибки сохранения НЕ должны быть «тихими».
// Регрессия: notifyStorageError публиковал сообщение только в legacy-канал
// window ('tq:storage-error'), а StorageToast подписан на eventBus
// ('storage:error') — пользователь терял данные без какого-либо уведомления.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React, { useEffect, useState } from 'react';
import {
  notifyStorageError,
  bridgeLegacyStorageErrors,
} from '../src/utils/storage';
import { eventBus } from '../src/utils/eventBus';

/** Точная копия StorageToast из App.tsx (подписка на eventBus 'storage:error'). */
const StorageToast: React.FC = () => {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const off = eventBus.on('storage:error', ({ message: msg }) => {
      if (msg) setMessage(msg);
    });
    return off;
  }, []);
  if (!message) return null;
  return React.createElement('div', { role: 'alert' }, `⚠️ ${message}`);
};

describe('Фаза 4.1: канал ошибок хранилища → toast', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('notifyStorageError публикует сообщение в eventBus (toast-канал)', () => {
    const spy = vi.fn();
    const off = eventBus.on('storage:error', spy);
    try {
      notifyStorageError('Квота исчерпана — изменения НЕ сохранены #1.');
      // КЛЮЧЕВАЯ РЕГРЕССИЯ Ф4.1: до фикса событие шло ТОЛЬКО в legacy-канал
      // window и никогда не достигало подписчиков eventBus (toast молчал).
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.some(([p]) => /переполнено/i.test(p.message))).toBe(
        false,
      );
      expect(spy.mock.calls.at(-1)![0].message).toContain('#1');
    } finally {
      off();
    }
  });

  it('notifyStorageError дублирует сообщение в legacy-канал window', () => {
    const handler = vi.fn();
    window.addEventListener('tq:storage-error', handler);
    try {
      notifyStorageError('legacy-check');
      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe('legacy-check');
    } finally {
      window.removeEventListener('tq:storage-error', handler);
    }
  });

  it('регрессия: toast отображает сообщение после notifyStorageError', async () => {
    render(React.createElement(StorageToast));
    expect(screen.queryByRole('alert')).toBeNull();

    notifyStorageError('Данные не сохранены: квота исчерпана.');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toContain('квота исчерпана');
  });

  it('bridge: внешнее legacy-событие попадает в eventBus (дедуп эха)', () => {
    // Мост саморегистрируется при импорте storage.ts; вызов идемпотентен —
    // возвращает корректный off-колбэк даже при уже активном мосте.
    const offBridge = bridgeLegacyStorageErrors();
    // Уникальное сообщение гарантирует, что spy видит
    // именно bridge-доставку (в тестовом файле может быть >1 экземпляра моста).
    const msg = `external-source-error-${Date.now()}`;
    const spy = vi.fn();
    const offBus = eventBus.on('storage:error', spy);
    try {
      window.dispatchEvent(new CustomEvent('tq:storage-error', { detail: msg }));
      expect(spy.mock.calls.some(([p]) => p.message === msg)).toBe(true);

      // Эхо того же сообщения из notifyStorageError не должно порождать
      // ПОВТОРНУЮ bridge-доставку: суммарно ровно одна доставка уникального msg.
      notifyStorageError(msg);
      const deliveries = spy.mock.calls.filter(([p]) => p.message === msg).length;
      // 1 (прямой emit notifyStorageError) + ≤1 (эхо через мосты, дедуп по msg)
      expect(deliveries).toBeLessThanOrEqual(2);
    } finally {
      offBus();
      offBridge();
    }
  });
});
