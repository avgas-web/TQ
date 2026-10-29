// ═══════════════════════════════════════════════════════════════
// ЭТАП 1.2 — безопасность API-ключей (ТЗ):
//  • ввод ключа в UI НЕ сохраняет его в localStorage, только в Zustand;
//  • модальное окно-предупреждение о рисках отображается ДО сохранения;
//  • masked input: полное значение не светится в DOM;
//  • scrubPersistedApiKeys вычищает ключи из legacy-снапшотов;
//  • persist(tq-map) больше никогда не пишет apiKey.
// ═══════════════════════════════════════════════════════════════
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import ApiKeyMaskedInput from '../src/components/ApiKeyMaskedInput';
import { useApiKeysStore, getEffectiveApiKey, maskKeyPreview } from '../src/store/useApiKeysStore';
import { scrubPersistedApiKeys, stripApiKeysDeep } from '../src/utils/apiKeySanitizer';

const SECRET = 'AIzaSyD-supersecret-key-3f9A';

// tests/setup.ts подменяет методы ЭКЗЕМПЛЯРА window.localStorage фильтрами
// «tq-*». Оригинальные (нативные) методы живы на Storage.prototype — через них
// читаем/пишем РЕАЛЬНОЕ содержимое хранилища в тестах безопасности.
const nativeStorage = (): {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
} => {
  const proto = Object.getPrototypeOf(window.localStorage) as Storage;
  return {
    getItem: proto.getItem.bind(window.localStorage),
    setItem: proto.setItem.bind(window.localStorage),
  };
};

function allStoredValues(): string[] {
  const { getItem } = nativeStorage();
  const out: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (!k) continue;
    out.push(getItem(k) ?? '');
  }
  return out;
}

beforeEach(() => {
  useApiKeysStore.getState().clearAllKeys();
  // чистим всё персистентное, что может содержать ключи
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  useApiKeysStore.getState().clearAllKeys();
  window.localStorage.clear();
});

describe('ApiKeyMaskedInput — сессионное хранение без localStorage', () => {
  it('ввод и подтверждение ключа кладут его ТОЛЬКО в Zustand-стор', async () => {
    render(<ApiKeyMaskedInput provider="google" label="Google Maps" />);

    const input = screen.getByLabelText(/API ключ Google Maps/i);
    expect(input).toHaveAttribute('type', 'password'); // masked input

    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/i }));

    // Модальное окно-предупреждение ОБЯЗАНО появиться до сохранения
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/Риск хранения API-ключа/i)).toBeInTheDocument();

    // До подтверждения ключ НЕ должен нигде храниться
    expect(useApiKeysStore.getState().manual.google).toBe('');
    expect(allStoredValues().join('')).not.toContain(SECRET);

    fireEvent.click(within(dialog).getByTestId('apikey-confirm'));

    await waitFor(() => {
      expect(useApiKeysStore.getState().manual.google).toBe(SECRET);
    });

    // ГЛАВНАЯ ПРОВЕРКА: ни одного записи секрета в localStorage
    expect(window.localStorage.length).toBe(0);
    expect(allStoredValues().join('')).not.toContain(SECRET);

    // Подтверждающее сообщение: память сессии
    expect(await screen.findByRole('status')).toHaveTextContent(/только в памяти/i);
  });

  it('полное значение ключа никогда не попадает в DOM (masked preview ≤4+4 символов)', async () => {
    const { container } = render(<ApiKeyMaskedInput provider="yandex" label="Yandex Maps" />);
    const input = screen.getByLabelText(/API ключ Yandex Maps/i);
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/i }));
    fireEvent.click(await screen.findByTestId('apikey-confirm'));

    await waitFor(() => expect(useApiKeysStore.getState().manual.yandex).toBe(SECRET));
    // password-поле очищено после коммита
    expect((input as HTMLInputElement).value).toBe('');
    // предпросмотр маскированный: видны только первые/последние 4 символа
    expect(container.textContent).toContain(maskKeyPreview(SECRET));
    expect(container.innerHTML).not.toContain(SECRET);
  });

  it('кнопка «Отмена» в модалке не сохраняет ключ', async () => {
    render(<ApiKeyMaskedInput provider="google" label="Google Maps" />);
    fireEvent.change(screen.getByLabelText(/API ключ Google Maps/i), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Отмена/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useApiKeysStore.getState().manual.google).toBe('');
    expect(window.localStorage.length).toBe(0);
  });

  it('пустой ввод не открывает модалку, а показывает инлайн-ошибку', () => {
    render(<ApiKeyMaskedInput provider="google" label="Google Maps" />);
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Введите API ключ/i);
  });
});

describe('useApiKeysStore + env — приоритеты источников', () => {
  it('env-ключ используется как фолбэк, ручной ввод имеет приоритет', () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'env-dev-key-1234567890');
    expect(getEffectiveApiKey('google')).toBe('env-dev-key-1234567890');
    useApiKeysStore.getState().setManualKey('google', SECRET);
    expect(getEffectiveApiKey('google')).toBe(SECRET);
    useApiKeysStore.getState().clearAllKeys();
    expect(getEffectiveApiKey('google')).toBe('env-dev-key-1234567890');
    // при этом ничего не записано на диск
    expect(window.localStorage.length).toBe(0);
  });

  it('maskKeyPreview раскрывает не более 4+4 символов', () => {
    expect(maskKeyPreview('short')).toBe('•••••');
    const m = maskKeyPreview(SECRET);
    expect(m.startsWith(SECRET.slice(0, 4))).toBe(true);
    expect(m.endsWith(SECRET.slice(-4))).toBe(true);
    expect(m).not.toContain(SECRET.slice(4, -4));
  });
});

describe('apiKeySanitizer — очистка legacy-снапшотов', () => {
  it('scrubPersistedApiKeys удаляет ключ из сохранённого tq-map старого формата', () => {
    const legacySnapshot = JSON.stringify({
      state: {
        project: { googleMaps: { apiKey: SECRET, enabled: true } },
        googleMaps: { apiKey: SECRET, enabled: true },
        yandexMaps: { apiKey: 'yndx-secret-000111222333', enabled: false },
      },
      version: 2,
    });
    // запись в обход tq*-блокировки setup.ts — напрямую через нативный Storage
    const { getItem, setItem } = nativeStorage();
    setItem('tq-map', legacySnapshot);

    expect(scrubPersistedApiKeys()).toBe(true);

    const after = getItem('tq-map') ?? '';
    expect(after).not.toContain(SECRET);
    expect(after).not.toContain('yndx-secret-000111222333');
    // служебные поля сохранены
    const parsed = JSON.parse(after) as { state: { googleMaps: { enabled?: boolean } } };
    expect(parsed.state.googleMaps.enabled).toBe(true);
  });

  it('stripApiKeysDeep идемпотентен и не трогает пустые ключи', () => {
    const obj = { googleMaps: { apiKey: SECRET }, project: { yandexMaps: { apiKey: '', enabled: true } } };
    const once = stripApiKeysDeep(obj);
    expect(stripApiKeysDeep(once)).toEqual(once);
    expect('apiKey' in (once.googleMaps as Record<string, unknown>)).toBe(false);
  });
});

// ─── Контракт persist-стора: парциализация tq-map не содержит apiKey ───
import mapStoreSrc from '../src/store/useMapStore?raw';

describe('useMapStore persist partialize — контракт «без секретов»', () => {
  it('в persisted-слайс провайдеров входит ТОЛЬКО enabled (apiKey вырезан)', () => {
    // Проверяем статически (детерминированно, без зависимости от async-гидрации):
    // внутри partialize googleMaps/yandexMaps сериализуются явно как { enabled }.
    const src = mapStoreSrc;
    // ищем ОБЪЕКТНУЮ форму (реализацию), а не декларацию типа в интерфейсе
    const partializeIdx = src.search(/partialize\s*:\s*\(/);
    expect(partializeIdx).toBeGreaterThan(-1);
    // окно = ТОЛЬКО тело возвращаемого объекта partialize (до закрывающей «});»)
    const objStart = src.indexOf('({', partializeIdx);
    expect(objStart).toBeGreaterThan(-1);
    const slice = src.slice(objStart, src.indexOf('});', objStart));
    expect(slice.length).toBeGreaterThan(50);
    expect(slice).toMatch(/googleMaps\s*:\s*\{\s*enabled:/);
    expect(slice).toMatch(/yandexMaps\s*:\s*\{\s*enabled:/);
    // в сам persisted-объект apiKey не подмешивается ни одним из полей
    // (срезаем комментарии — они не влияют на сериализацию)
    const codeOnly = slice.replace(/\/\*.*?\*\//gs, '').replace(/\/\/[^\n]*/g, '');
    expect(codeOnly).not.toMatch(/apiKey/);
  });

  it('легаси-сеттеры стора делегируют ключ в СЕССИОННЫЙ стор, а не в persist', () => {
    // setGoogleMapsApiKey обязан роутить в useApiKeysStore (memory-only),
    // и НЕ должен присваивать ключ состоянию useMapStore.
    const src = mapStoreSrc;
    // реализация: 'setGoogleMapsApiKey: (apiKey) => {' (без аннотации типа)
    const implIdx = src.search(/setGoogleMapsApiKey:\s*\(apiKey\)\s*=>/);
    expect(implIdx).toBeGreaterThan(-1);
    const setterSlice = src.slice(implIdx, implIdx + 400);
    expect(setterSlice).toContain('useApiKeysStore');
    expect(setterSlice).not.toMatch(/set\(\s*\{\s*googleMaps[^}]*apiKey/);
  });
});
