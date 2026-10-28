// Юнит-тесты персистентности пользовательских тактических карт:
// IndexedDB (fake-indexeddb) + zustand-слайс слоёв.
import { describe, it, expect, beforeEach } from 'vitest';
import type { UserMapLayer } from '../src/types';
import {
  saveUserLayerToIndexedDB, loadUserLayerFromIndexedDB, deleteUserLayerFromIndexedDB,
  listUserLayerIds, getUserLayersTotalBytes, validateUserLayerSize, USER_LAYER_LIMITS,
  formatBytes, checkLocalStorageQuota, isIndexedDbAvailable,
} from '../src/utils/storage';
import { useStore } from '../src/store/useStore';

const layerFixture = (id: string, over: Partial<UserMapLayer> = {}): UserMapLayer => ({
  id, kind: 'raster', format: 'image',
  meta: { name: id, loadedAt: new Date().toISOString(), author: 'test', fileName: `${id}.png`, fileSize: 123, sourceFormat: 'image' },
  bbox: { north: 56, south: 55, east: 38, west: 37 }, projection: 'EPSG:4326',
  visible: true, opacity: 0.8, imageDataUrl: 'data:image/png;base64,AAAA', ...over,
});

describe('storage: лимиты и метки объёма', () => {
  it('validateUserLayerSize: пустой/огромный -> текст ошибки, нормальный -> null', () => {
    expect(validateUserLayerSize(0, 'a.png')).toMatch(/пуст или повреждён/);
    expect(validateUserLayerSize(-5)).toMatch(/пуст или повреждён/);
    expect(validateUserLayerSize(NaN)).toMatch(/пуст или повреждён/);
    expect(validateUserLayerSize(USER_LAYER_LIMITS.maxBytesPerLayer + 1, 'big.tif'))
      .toMatch(/слишком большой.*Предел/s);
    expect(validateUserLayerSize(1024, 'ok.png')).toBeNull();
  });

  it('formatBytes человекочитаемо', () => {
    expect(formatBytes(0)).toBe('0 Б');
    expect(formatBytes(1024)).toBe('1 КБ');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 МБ');
  });

  it('checkLocalStorageQuota возвращает доли 0..100', () => {
    const q = checkLocalStorageQuota();
    expect(q.percentage).toBeGreaterThanOrEqual(0);
    expect(q.percentage).toBeLessThanOrEqual(100);
    expect(q.used).toBeGreaterThanOrEqual(0);
  });

  it('IndexedDB доступен в тестовой среде (fake)', () => {
    expect(isIndexedDbAvailable()).toBe(true);
  });
});

describe('storage: CRUD записей слоёв в IndexedDB', () => {
  beforeEach(async () => {
    for (const id of await listUserLayerIds()) await deleteUserLayerFromIndexedDB(id);
  });

  it('save/load/delete — полный цикл с бинарным sourceBlob', async () => {
    const blob = new Uint8Array([1, 2, 3, 4]).buffer;
    const ok = await saveUserLayerToIndexedDB({
      id: 'L-BIN', imageDataUrl: 'data:image/png;base64,BIN', sourceBlob: blob,
      bytes: 4, timestamp: 0,
    });
    expect(ok).toBe(true);
    const rec = await loadUserLayerFromIndexedDB('L-BIN');
    expect(rec).not.toBeNull();
    expect(rec!.imageDataUrl).toBe('data:image/png;base64,BIN');
    expect(new Uint8Array(rec!.sourceBlob!)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await listUserLayerIds()).toContain('L-BIN');
    expect(await getUserLayersTotalBytes()).toBe(4);
    expect(await deleteUserLayerFromIndexedDB('L-BIN')).toBe(true);
    expect(await loadUserLayerFromIndexedDB('L-BIN')).toBeNull();
  });

  it('load несуществующего id -> null; delete чужого id не падает', async () => {
    expect(await loadUserLayerFromIndexedDB('nope')).toBeNull();
    expect(await deleteUserLayerFromIndexedDB('nope')).toBe(true);
  });

  it('повторное сохранение того же id перезаписывает запись (timestamp обновляется)', async () => {
    await saveUserLayerToIndexedDB({ id: 'L1', bytes: 10, timestamp: 1 });
    await saveUserLayerToIndexedDB({ id: 'L1', imageDataUrl: 'data:x', bytes: 20, timestamp: 2 });
    const rec = await loadUserLayerFromIndexedDB('L1');
    expect(rec!.bytes).toBe(20);
    expect(rec!.timestamp).toBeGreaterThan(1);
    expect((await listUserLayerIds()).filter((i) => i === 'L1')).toHaveLength(1);
  });
});

describe('useStore: слайс пользовательских слоёв', () => {
  const st = () => useStore.getState();

  it('addOrUpdateUserLayer кладёт слой в проект, растр уходит в IndexedDB, dataUrl из стора вычищается', async () => {
    const l = layerFixture('S1');
    await st().addOrUpdateUserLayer(l);
    const stored = st().project.userLayers!.find((x) => x.id === 'S1')!;
    expect(stored).toBeDefined();
    expect(stored.imageDataUrl).toBeUndefined(); // тяжёлые данные — только в IDB
    const rec = await loadUserLayerFromIndexedDB('S1');
    expect(rec?.imageDataUrl).toBe('data:image/png;base64,AAAA');
    // повторное добавление с тем же id — замена, а не дубль
    await st().addOrUpdateUserLayer(layerFixture('S1', { opacity: 0.3 }));
    expect(st().project.userLayers!.filter((x) => x.id === 'S1')).toHaveLength(1);
    expect(st().project.userLayers!.find((x) => x.id === 'S1')!.opacity).toBe(0.3);
    await st().removeUserLayer('S1');
  });

  it('векторный слой без blob не создаёт запись в IDB, remove чистит и стор, и IDB', async () => {
    const v = layerFixture('S-VEC', { kind: 'vector', format: 'geojson', imageDataUrl: undefined, features: [] });
    await st().addOrUpdateUserLayer(v);
    expect(await loadUserLayerFromIndexedDB('S-VEC')).toBeNull();
    const r = layerFixture('S2');
    await st().addOrUpdateUserLayer(r);
    expect(await loadUserLayerFromIndexedDB('S2')).not.toBeNull();
    await st().removeUserLayer('S2');
    expect(st().project.userLayers!.some((x) => x.id === 'S2')).toBe(false);
    expect(await loadUserLayerFromIndexedDB('S2')).toBeNull();
    await st().removeUserLayer('S-VEC');
  });

  it('setUserLayerVisible / setUserLayerOpacity (кламп 0..1, NaN игнорируется)', () => {
    const before = st().project.userLayers!.length;
    void before;
    const l = layerFixture('S3', { imageDataUrl: undefined });
    st().addOrUpdateUserLayer(l);
    st().setUserLayerVisible('S3', false);
    expect(st().project.userLayers!.find((x) => x.id === 'S3')!.visible).toBe(false);
    st().setUserLayerOpacity('S3', 1.7);
    expect(st().project.userLayers!.find((x) => x.id === 'S3')!.opacity).toBe(1);
    st().setUserLayerOpacity('S3', -3);
    expect(st().project.userLayers!.find((x) => x.id === 'S3')!.opacity).toBe(0);
    st().setUserLayerOpacity('S3', NaN);
    expect(st().project.userLayers!.find((x) => x.id === 'S3')!.opacity).toBe(0); // прежнее значение
    void st().removeUserLayer('S3');
  });

  it('restoreUserLayers подтягивает imageDataUrl из IndexedDB после «перезагрузки»', async () => {
    const l = layerFixture('S4');
    await st().addOrUpdateUserLayer(l); // dataUrl уже в IDB, в сторе — undefined
    // имитируем гидрацию из localStorage: слой без данных
    useStore.setState((s) => ({
      project: { ...s.project, userLayers: (s.project.userLayers ?? []).map((x) => ({ ...x, imageDataUrl: undefined })) },
    }));
    expect(st().project.userLayers!.find((x) => x.id === 'S4')!.imageDataUrl).toBeUndefined();
    await st().restoreUserLayers();
    expect(st().project.userLayers!.find((x) => x.id === 'S4')!.imageDataUrl)
      .toBe('data:image/png;base64,AAAA');
    await st().removeUserLayer('S4');
  });

  it('loadUserLayerSource отдаёт sourceBlob MBTiles из IDB', async () => {
    const mb = layerFixture('S5', {
      format: 'mbtiles', kind: 'raster', imageDataUrl: undefined,
      sourceBlob: new Uint8Array([9, 8, 7]).buffer,
      tileInfo: { minZoom: 0, maxZoom: 3, format: 'png' },
    });
    await st().addOrUpdateUserLayer(mb);
    expect(st().project.userLayers!.find((x) => x.id === 'S5')!.sourceBlob).toBeUndefined();
    const buf = await st().loadUserLayerSource('S5');
    expect(new Uint8Array(buf!)).toEqual(new Uint8Array([9, 8, 7]));
    await st().removeUserLayer('S5');
    expect(await st().loadUserLayerSource('S5')).toBeNull();
  });

  it('gcUserLayerStorage удаляет осиротевшие записи IDB', async () => {
    await saveUserLayerToIndexedDB({ id: 'ORPHAN', bytes: 1, timestamp: 1 });
    expect(await listUserLayerIds()).toContain('ORPHAN');
    await st().gcUserLayerStorage();
    expect(await listUserLayerIds()).not.toContain('ORPHAN');
  });

  it('userLayerRecords: только метаданные, hasBlob по факту данных', async () => {
    const withBlob = layerFixture('R1');
    const without = layerFixture('R2', { kind: 'vector', imageDataUrl: undefined, features: [] });
    await st().addOrUpdateUserLayer(withBlob);
    await st().addOrUpdateUserLayer(without);
    const recs = st().userLayerRecords();
    const r1 = recs.find((r) => r.layer.id === 'R1')!;
    const r2 = recs.find((r) => r.layer.id === 'R2')!;
    expect(r1.hasBlob).toBe(true);
    expect(r1.layer.imageDataUrl).toBeUndefined();
    expect(r2.hasBlob).toBe(false);
    void st().removeUserLayer('R1');
    void st().removeUserLayer('R2');
  });
});
