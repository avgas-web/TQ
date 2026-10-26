// Интеграционные тесты (RTL): в режиме Мастера точки ставятся ТОЛЬКО на
// загруженную карту. До готовности подложки клики по области живой карты
// игнорируются, поверх показывается оверлей с причиной; после загрузки OSM
// (ensureDefaultTileMap → mapLoaded) клик добавляет точку.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MissionWizard } from '../src/components/wizard/MissionWizard';
import { StartPointsStep } from '../src/components/wizard/StartPointsStep';
import { TargetPointsStep } from '../src/components/wizard/TargetPointsStep';
import { useMissionWizardStore } from '../src/store/useMissionWizardStore';
import { useMapStore } from '../src/store/useMapStore';

// ═══════════════════════════════════════════════════════════════
// РЕЦЕПТ А: fake timers + mock модуля автозагрузки.
// Корень проблемы детерминированности: все пути автозагрузки OSM
// (useAppInitialization, WizardMapPanel, MapCanvas «автономный» эффект)
// отложены window.setTimeout(…, 0) — это выход за commit-фазу React
// (фикс краша #127), но в jsdom/happy-dom macrotask-очередь RTL не
// прокручивается синхронно, и тест зависал на ожидании готовности карты.
// Решение: мок ensureDefaultTileMap выполняет ТОТ ЖЕ продакшен-путь
// (те же действия стора), но синхронно; фоновые таймеры автозагрузки
// заморожены fake timers и никогда не срабатывают самовольно.
// Тест проверяет контракт блокировки кликов (readiness-гейт), а не
// внутренность таймеров автозагрузки (она покрыта mapStability).
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// РЕЦЕПТ А: детерминированная прокрутка macrotask-очереди.
// Корень проблемы невоспроизводимости: все пути автозагрузки OSM
// (useAppInitialization, WizardMapPanel, MapCanvas «автономный» эффект)
// отложены window.setTimeout(…, 0) — это выход за commit-фазу React
// (фикс краша #127), но RTL не прокручивает macrotasks синхронно, и
// тест зависал на ожидании готовности карты.
// vi.useFakeTimers в связке с RTL/happy-dom недопустим: setInterval
// внутри MapCanvas (poller курсора) после freeze превращается в
// бесконечный synchronous-цикл при flush → раннер вешается НАВСЕГДА
// (именно этот hang мы наблюдали). Поэтому — собственный патч ТОЛЬКО
// setTimeout/clearTimeout: колбэки регистрируются и исполняются по
// явной команде flushTimers(); setInterval остаётся реальным.
// Мок ensureDefaultTileMap выполняет ТОТ ЖЕ продакшен-путь стора, но
// синхронно; публикация готовности подложки имитирует onload тайла
// (сеть в happy-dom недоступна физически).
// ═══════════════════════════════════════════════════════════════
vi.mock('../src/hooks/useAppInitialization', () => ({
  ensureDefaultTileMap: () => {
    const st = useMapStore.getState();
    if (st.map) return; // идемпотентность — как в проде
    st.toggleOpenStreetMap(true);
    st.setOSMTileServer(st.openStreetMap.tileServer ?? 'osm');
    st.loadActiveTileMap({ lat: 55.7558, lng: 37.6173 }, 10);
  },
  useAppInitialization: () => undefined,
}));

// КЛЮЧЕВОЙ МОК СТАБИЛЬНОСТИ (завершение «Рецепта А»): в happy-dom сеть
// физически недоступна, а Image без src не генерирует ни onload, ни onerror —
// loadTileImage висел до внутреннего 8–10-секундного timeout'а. Через очередь
// withTileSlot это превращалось в каскад волн по 4 тайла: каждый render-такт
// waitFor порождал новые сетевые промисы, и тест упирался в testTimeout.
// Мок резолвит тайлы мгновенно в null («не загрузился») — контракт readiness-
// гейта и публикации готовности от этого не зависит (готовность публикуется
// детерминированно через simulateTilesLoaded), а фоновая сеть исчезает.
// ВАЖНО: vi.mock хостится в ВЕРХ модуля (hoisting), поэтому ссылка на
// локальную переменную невозможна — используем глобальный счётчик vitest.
// КЛЮЧЕВОЙ ФИКС ХЭНГА: сам факт резолва mock'а в null НЕ помогал —
// диагностика через console.trace показала ВЕЧНЫЙ каскад loadTiles→flush:
// все тайлы «не загрузились» → isLoading никогда не сбрасывался → waitFor
// крутил render-циклы до testTimeout. Мок возвращает СИНХРОННЫЙ успешный
// Image (new Image() в happy-dom валиден без src; canvas.getContext('2d')
// стабильно отдаёт shim), поэтому очередь тайлов завершается за один tick,
// isLoading гаснет, а готовность подложки публикуется детерминированно.
function makeFakeTileImage(): HTMLImageElement {
  const img = new Image();
  Object.defineProperty(img, 'complete', { value: true });
  Object.defineProperty(img, 'naturalWidth', { value: 256 });
  Object.defineProperty(img, 'naturalHeight', { value: 256 });
  return img;
}
vi.mock('../src/utils/openStreetMap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/openStreetMap')>();
  return {
    ...actual,
    loadTileImage: async (): Promise<HTMLImageElement | null> => makeFakeTileImage(),
    loadTileWithMirrors: async (): Promise<HTMLImageElement | null> => makeFakeTileImage(),
  };
});

const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);
class PendingTimer {
  readonly fn: () => void;
  readonly ms: number;
  constructor(fn: () => void, ms: number) { this.fn = fn; this.ms = ms; }
}
let pendingTimers = new Map<number, PendingTimer>();
let timerSeq = 1;
window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]): number => {
  if (typeof fn !== 'function') return realSetTimeout(fn as (...a: unknown[]) => void, ms, ...args);
  const id = timerSeq++;
  pendingTimers.set(id, new PendingTimer(() => fn(...(args as never[])), ms ?? 0));
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = ((id?: number): void => {
  if (id === undefined) return;
  pendingTimers.delete(id);
}) as typeof window.clearTimeout;

/** Исполнить все зарегистрированные macrotask-колбэки (до 4 волн:
 *  колбэки могут ставить новые таймеры — двухстадийная публикация).
 *  КОРНЕВОЙ ФИКС ВЕЧНОГО ХЭНГА ТЕСТА: задержанные колбэки (ms > 0) НЕ
 *  исполняются синхронно. Пример фатального каскада: автозагрузка карты
 *  ставит setTimeout(ensureDefaultTileMap, 0), ensureDefaultTileMap →
 *  loadActiveTileMap → смена карты → MapCanvas регистрирует НОВЫЙ такой же
 *  таймер; синхронный flush бесконечно порождает волну за волной и упирался
 *  в глобальный timeout раннера (60 с на каждый тест). Отложенные колбэки
 *  просто удаляются из очереди (эквивалент clearTimeout): они являются либо
 *  сетевыми таймаутами прерывания (в happy-dom сеть недоступна физически),
 *  либо отложенной автозагрузкой — а её продакшен-путь тест воспроизводит
 *  ЯВНО (мок ensureDefaultTileMap + simulateTilesLoaded), что детерминировано
 *  и не зависит от macrotask-очереди jsdom. Синхронно исполняются только
 *  ms === 0 — микротасковые публикации готовности (stage-2 publishMapLoaded). */
async function flushTimers(): Promise<void> {
  await act(async () => {
    for (let wave = 0; wave < 4 && pendingTimers.size > 0; wave++) {
      const batch = [...pendingTimers.values()];
      pendingTimers = new Map();
      for (const t of batch) {
        if (t.ms > 0) continue; // отложенные/сетевые таймеры — не исполняем
        t.fn();
      }
      await Promise.resolve();
    }
  });
}

/** Синхронная имитация готовности подложки: тот же стор-путь, что публикует
 *  MapCanvas в stage-1 publishMapLoaded после загрузки первого тайла. */
function simulateTilesLoaded(): void {
  act(() => {
    useMapStore.getState().publishMapLoaded(true);
  });
}

/** Детерминированная прокрутка микротаск-очереди React (act + N тиков).
 *  ЗАМЕНА vi.waitFor для проверок DOM-оверлеев: waitFor поллитно опрашивает
 *  DOM реальными macrotask'ами; при активном каскаде сетевых эффектов карты
 *  это уводило тест в testTimeout даже когда состояние стора уже готово.
 *  Акт-цикл исполняет все очередь React-обновлений синхронно и завершается. */
async function flushReact(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

class ROShim {
  private cb: (entries: ResizeObserverEntry[]) => void;
  constructor(cb: (entries: ResizeObserverEntry[]) => void) { this.cb = cb; }
  observe(el: Element): void {
    this.cb([{ target: el, contentRect: { x: 0, y: 0, top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800 }, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry]);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  // Пере-создаём очередь таймеров между тестами: «хвост» прошлого теста
  // не должен исполняться в новом дереве (защита от setState-on-unmounted).
  pendingTimers = new Map();
  vi.stubGlobal('ResizeObserver', ROShim);
  try { localStorage.clear(); } catch { /* noop */ }
  useMissionWizardStore.setState(useMissionWizardStore.getInitialState());
  // ВАЖНО: setState(getInitialState()) НЕ отменяет уже запланированную
  // zustand-persist запись в localStorage (она ставится через setTimeout
  // внутри set()). Без purge() на следующем set() мок-карта из предыдущего
  // теста «воскресала» бы в сторе и readiness-оверлей не появлялся.
  useMapStore.persist.clearStorage();
  useMapStore.setState({ ...useMapStore.getInitialState(), map: null, mapLoaded: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function gotoStartPointsStep(): Promise<void> {
  // Этап 1 — выбор карт: штатный путь пользователя (клик по карточке Esri).
  // ВНИМАНИЕ: не менять на прямой setState в этом файле — здесь мок-таймеры
  // (flushTimers), и тест обязан проходить через реальный UI-контракт этапа.
  fireEvent.click(screen.getByTestId('map-choice-esri'));
  await flushReact(2);
  fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
  await flushReact(2);
  // Этап 2 — тип аппарата
  fireEvent.click(screen.getByTestId('craft-card-drone'));
  await flushReact(2);
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
  await flushTimers();
  await flushReact(4);
  expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
  await flushReact(4);
  expect(useMissionWizardStore.getState().currentStep).toBe('start-points');
  // КАРТА ДОЛЖНА БЫТЬ ГОТОВА до любых кликов (требование ТЗ: точки ставятся
  // только на загруженную подложку). Прокручиваем отложенные эффекты
  // автозагрузки (fake timers), а затем детерминированно публикуем готовность
  // подложки тем же стор-путём, что MapCanvas после onload первого тайла
  // (в jsdom/happy-dom реальная загрузка Image не происходит).
  await flushTimers();
  simulateTilesLoaded();
  await flushReact(6);
  expect(screen.queryByTestId('wizard-map-not-ready-overlay')).toBeNull();
}

/** Клик по области ЖИВОЙ карты (не mini-map) ДО готовности подложки. */
function clickLiveMapBlind(testId: string, clientX: number, clientY: number): boolean {
  const live = screen.getByTestId(testId);
  live.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, x: 0, y: 0, right: 640, bottom: 480, toJSON: () => ({}) });
  const w = useMissionWizardStore.getState();
  const before = w.startPoints.length + w.targetPoints.length;
  fireEvent.click(live, { clientX, clientY });
  const after = useMissionWizardStore.getState();
  return after.startPoints.length + after.targetPoints.length > before;
}

/** Клик по области ЖИВОЙ карты (не mini-map). Возвращает true, если точка добавилась. */
function clickLiveMap(testId: string, clientX: number, clientY: number): boolean {
  return clickLiveMapBlind(testId, clientX, clientY);
}

describe('Работа с картой в режиме Мастера', () => {
  it('до загрузки подложки клик по живой карте НЕ добавляет точку и показывает оверлей', async () => {
    // Контракт: пока readiness.ready === false — клики игнорируются, поверх
    // карты оверлей с причиной. Монтируем карту этапов БЕЗ мастера (мастер сам
    // автозагружает OSM на mount — это другой, позитивный сценарий, покрыт
    // следующим тестом), map=null → блокировка активна сразу.
    render(<StartPointsStep />);
    await flushReact(4);
    const panel = screen.getByTestId('wizard-map-panel');
    expect(panel).toBeTruthy();

    const overlay = screen.getByTestId('wizard-map-not-ready-overlay');
    expect(overlay.textContent).toMatch(/Карта ещё не за|дождитесь/i);
    expect(clickLiveMapBlind('wizard-live-map-start', 200, 150)).toBe(false);
    expect(useMissionWizardStore.getState().startPoints).toHaveLength(0);

    // Продакшен-путь: автозагрузка OSM (мок выполняет те же действия стора,
    // что реальный ensureDefaultTileMap) + публикация готовности подложки —
    // оверлей исчезает, клик ставит точку.
    act(() => { useMapStore.getState().toggleOpenStreetMap(true); });
    await flushTimers();
    simulateTilesLoaded();
    await flushReact(6);
    expect(screen.queryByTestId('wizard-map-not-ready-overlay')).toBeNull();
    expect(clickLiveMapBlind('wizard-live-map-start', 200, 150)).toBe(true);
    expect(useMissionWizardStore.getState().startPoints).toHaveLength(1);
  });

  it('после готовности OSM-подложки клик по живой карте добавляет точку', async () => {
    render(<MissionWizard />);
    await gotoStartPointsStep(); // внутри — прокрутка автозагрузки + ожидание готовности
    expect(screen.queryByTestId('wizard-map-not-ready-overlay')).toBeNull();
    expect(clickLiveMap('wizard-live-map-start', 200, 150)).toBe(true);
    expect(useMissionWizardStore.getState().startPoints).toHaveLength(1);
  });

  it('Google без API-ключа: оверлей требует ключ и предлагает бесплатную подложку, точки не ставятся', async () => {
    render(<MissionWizard />);
    await gotoStartPointsStep();
    act(() => { useMapStore.getState().setOSMTileServer('google'); });
    await flushReact(6);
    const overlay = screen.getByTestId('wizard-map-not-ready-overlay');
    expect(overlay.textContent).toMatch(/API-ключ Google/);
    // ТЗ: 2ГИС удалён полностью — подсказка ведёт на бесплатные Esri/OSM-подложки.
    expect(overlay.textContent).not.toMatch(/2ГИС/);
    expect(overlay.textContent).toMatch(/Esri\/OSM|бесплатн/i);
    expect(clickLiveMap('wizard-live-map-start', 300, 200)).toBe(false);
  });

  it('Этап целей: клики блокируются до готовности карты, после загрузки OSM цель ставится', async () => {
    const w = useMissionWizardStore.getState();
    // Этап 1 (выбор карт) проходит через UI-экшены стора; в этом файле
    // мок-таймеры, поэтому синхронизация подложки догоняется flushTimers ниже.
    w.toggleMapChoice('esri');
    w.setCraftType('drone');
    w.goToNextStep(); // start-points
    w.addStartPoint({ name: 'С1', lat: 55.75, lon: 37.6, x: 100, y: 100 });
    // Монтируем карту целей на гарантированно незагруженной подложке
    // (map=null в beforeEach — см. комментарий к первому тесту).
    render(<TargetPointsStep />);
    await flushReact(4);
    expect(screen.getByTestId('wizard-live-map-target')).toBeTruthy();

    const overlay = screen.getByTestId('wizard-map-not-ready-overlay-target');
    expect(overlay.textContent).toMatch(/Карта ещё не загружена|Загрузка тайлов/);
    expect(clickLiveMapBlind('wizard-live-map-target', 200, 150)).toBe(false);
    expect(useMissionWizardStore.getState().targetPoints).toHaveLength(0);

    // Продакшен-путь автозагрузки OSM выполняется самим WizardMapPanel при
    // монтировании (ensureDefaultTileMap на setTimeout(0) — вне commit-фазы,
    // фикс краша #127). Детерминированно прокруваем macrotask-очередь fake
    // timers, затем публикуем готовность подложки (имитация onload тайла).
    await flushTimers();
    simulateTilesLoaded();
    await flushReact(6);
    expect(screen.queryByTestId('wizard-map-not-ready-overlay-target')).toBeNull();
    expect(clickLiveMapBlind('wizard-live-map-target', 200, 150)).toBe(true);
    expect(useMissionWizardStore.getState().targetPoints).toHaveLength(1);
  });

  it('мастер при монтировании сам гарантирует загрузку карты (без ручного вызова)', async () => {
    // Корневой фикс UX-требования: в режиме мастера точки ставятся только на
    // загруженную карту — и карта загружается автоматически, пользователю не
    // нужен legacy-«Редактор». Проверяем полный путь через MissionWizard без
    // явного вызова автозагрузки в тесте: мастер/панель сами создают OSM-подложку
    // (мок ensureDefaultTileMap = тот же продакшен-путь стора), остаётся лишь
    // имитировать onload первого тайла (сеть в jsdom недоступна физически).
    render(<MissionWizard />);
    // Этап 1: выбор карты — штатный путь UI (см. gotoStartPointsStep выше)
    fireEvent.click(screen.getByTestId('map-choice-esri'));
    await flushReact(2);
    fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
    await flushReact(2);
    fireEvent.click(screen.getByTestId('craft-card-drone'));
    await flushReact(2);
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
    await flushTimers();
    await flushReact(4);
    expect(screen.getByRole('button', { name: /Далее/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
    await flushReact(4);
    expect(screen.getByTestId('wizard-map-panel')).toBeTruthy();
    expect(useMapStore.getState().map?.bounds).not.toBeNull(); // автозагрузка сработала сама
    simulateTilesLoaded();
    await flushReact(6);
    expect(screen.queryByTestId('wizard-map-not-ready-overlay')).toBeNull();
    expect(clickLiveMapBlind('wizard-live-map-start', 200, 150)).toBe(true);
    expect(useMissionWizardStore.getState().startPoints).toHaveLength(1);
  });
});
