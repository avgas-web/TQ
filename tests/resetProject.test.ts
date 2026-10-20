// Тест кнопки «🔄 Сброс»: resetProject обязан удалить ВСЕ данные о точках,
// маршрутах, зонах и парке дронов — и в памяти, и в persist-хранилище
// (иначе после F5 старые данные «воскресают» через гидрацию zustand persist).
import { describe, it as vitestCase } from 'vitest';

let passed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; })
    .catch((e: unknown) => { failures.push(`${name}: ${(e as Error).message}`); });
}

// Динамические импорты внутри тестов — после моков.
async function loadStores() {
  const map = await import('../src/store/useMapStore');
  const mission = await import('../src/store/useMissionStore');
  const fleet = await import('../src/store/useFleetStore');
  const shim = await import('../src/store/useStoreShim');
  return { useMapStore: map.useMapStore, useMissionStore: mission.useMissionStore, useFleetStore: fleet.useFleetStore, useStore: shim.useStore };
}

describe('resetProject (кнопка Сброс)', () => {
  vitestCase('удаляет все точки, маршруты, зоны и дроны из состояния', async () => {
    // localStorage ДО сброса — «грязное» состояние с данными (эмуляция
    // записанного persist-кэша предыдущей сессии).
    localStorage.setItem('tq-map', JSON.stringify({ state: { markers: [{ id: 'ghost' }] }, version: 3 }));
    localStorage.setItem('tq-mission', JSON.stringify({ state: { routes: [{ id: 'ghost-route' }] }, version: 1 }));
    localStorage.setItem('totalquadro-storage', JSON.stringify({ markers: [{ id: 'legacy' }] }));
    localStorage.setItem('totalquadro-backup-1', '{}');

    const { useMapStore, useMissionStore, useFleetStore, useStore } = await loadStores();

    // Наполняем сторы реальными данными через штатные экшены.
    useMapStore.getState().loadMap({
      id: 'm1', name: 'Тест', source: 'image', width: 1000, height: 800,
      bounds: { north: 60, south: 59, east: 31, west: 30 }, dataUrl: '',
    } as never);
    useMapStore.getState().addMarker({ name: 'Точка А', x: 100, y: 200, lat: 59.5, lon: 30.5 });
    useMapStore.getState().addMarker({ name: 'Точка Б', x: 300, y: 400, lat: 59.4, lon: 30.6 });
    useMapStore.getState().addRestriction({ type: 'polygon', name: 'NFZ', points: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
    ] } as never);
    useMissionStore.getState().addRoute([
      { x: 100, y: 200, lat: 59.5, lon: 30.5 },
      { x: 300, y: 400, lat: 59.4, lon: 30.6 },
    ] as never, 'Маршрут 1');
    useFleetStore.getState().resetFleet(); // чистый старт парка

    // Предусловие: данные реально есть.
    assert(useMapStore.getState().markers.length >= 2, 'до сброса должны быть маркеры');
    assert(useMapStore.getState().restrictions.length >= 1, 'до сброса должны быть зоны');
    assert(useMissionStore.getState().routes.length >= 1, 'до сброса должен быть маршрут');

    // Действие — ровно то, что вызывает кнопка в Toolbar.
    useStore.getState().resetProject();

    // Постусловие 1: всё удалено из памяти.
    assert(useMapStore.getState().markers.length === 0, `маркеры очищены (факт: ${useMapStore.getState().markers.length})`);
    assert(useMapStore.getState().restrictions.length === 0, 'зоны очищены');
    assert(useMapStore.getState().map === null, 'карта сброшена');
    assert(useMapStore.getState().selectedMarkerId === null, 'выделение снято');
    assert(useMissionStore.getState().routes.length === 0, `маршруты очищены (факт: ${useMissionStore.getState().routes.length})`);
    assert(useMissionStore.getState().activeRouteId === null, 'активный маршрут снят');
    assert(useMissionStore.getState().startPointIds.length === 0 && useMissionStore.getState().goalPointIds.length === 0, 'точки старта/цели очищены');
    assert(useFleetStore.getState().drones.length === 0 && useFleetStore.getState().droneAssignments.length === 0, 'парк дронов очищен');
    assert(useMissionStore.getState().isProcessing === false, 'страж isProcessing снят');

    // Постусловие 2: persist-хранилище ПЕРЕЗАПИСАНО пустым состоянием
    // (zustand сериализует каждый set()) и НЕ содержит ghost-данных.
    const savedMap = JSON.parse(localStorage.getItem('tq-map') ?? '{"state":{"markers":[{}}') as { state?: { markers?: unknown[] } };
    assert((savedMap.state?.markers?.length ?? 0) === 0, 'tq-map в localStorage не содержит маркеров');
    const savedMis = JSON.parse(localStorage.getItem('tq-mission') ?? '{"state":{"routes":[{}}') as { state?: { routes?: unknown[] } };
    assert((savedMis.state?.routes?.length ?? 0) === 0, 'tq-mission в localStorage не содержит маршрутов');

    // Постусловие 3: legacy-ключи удалены (иначе App.restoreMapFromStorage
    // после F5 вернёт старые данные — исходный баг «Сброс не работает»).
    await Promise.resolve(); // дождаться микротask-цепочки finally
    await Promise.resolve();
    assert(localStorage.getItem('totalquadro-storage') === null, 'legacy totalquadro-storage удалён');
    assert(localStorage.getItem('totalquadro-backup-1') === null, 'backup-ключ удалён');
  });

  vitestCase('Сброс работает даже при зависшем isProcessing (блокировка снята)', async () => {
    const { useMapStore, useMissionStore, useStore } = await loadStores();
    useMissionStore.setState({ isProcessing: true });
    // resetProject обязан сбросить и карту — проверяем это явно (баг:
    // после сброса нельзя было создать маршрут, т.к. map === null).
    useStore.getState().resetProject();
    assert(useMissionStore.getState().isProcessing === false, 'isProcessing=false после сброса');
    assert(useMapStore.getState().map === null, 'карта сброшена до null');

    // Восстанавливаем карту штатным экшеном и создаём маршрут через фасад:
    // guarded mutate-экшен обязан пройти (страж разблокирован принудительно).
    useMapStore.getState().loadMap({
      id: 'm2', name: 'Тест2', source: 'image', width: 1000, height: 800,
      bounds: { north: 60, south: 59, east: 31, west: 30 }, dataUrl: '',
    } as never);
    const id = useStore.getState().addRoute([
      { x: 100, y: 200, lat: 59.5, lon: 30.5 },
      { x: 300, y: 400, lat: 59.4, lon: 30.6 },
    ] as never, 'after-reset');
    assert(typeof id === 'string' && useMissionStore.getState().routes.length === 1,
      `маршрут после сброса создаётся (id=${String(id)}, routes=${useMissionStore.getState().routes.length})`);
  });
});

export { check };
void check; void failures; void passed;
