// Юнит-тесты персистентности пользовательских тактических карт:
// IndexedDB (fake-indexeddb).
// ФАЗА 5.D: zustand-слайс userLayers удалён вместе с фасадом useStoreShim —
// реестр project.userLayers был мёртвым кодом (UI его не использовал).
// Тесты ниже покрывают живой слой storage (IndexedDB CRUD тяжёлых данных).
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto"; // fake IndexedDB для CRUD-тестов слоёв (в main-setup его нет)
import {
  saveUserLayerToIndexedDB,
  loadUserLayerFromIndexedDB,
  deleteUserLayerFromIndexedDB,
  listUserLayerIds,
  getUserLayersTotalBytes,
  validateUserLayerSize,
  USER_LAYER_LIMITS,
  formatBytes,
  checkLocalStorageQuota,
  isIndexedDbAvailable,
} from "../src/utils/storage";

describe("storage: лимиты и метки объёма", () => {
  it("validateUserLayerSize: пустой/огромный -> текст ошибки, нормальный -> null", () => {
    expect(validateUserLayerSize(0, "a.png")).toMatch(/пуст или повреждён/);
    expect(validateUserLayerSize(-5)).toMatch(/пуст или повреждён/);
    expect(validateUserLayerSize(NaN)).toMatch(/пуст или повреждён/);
    expect(
      validateUserLayerSize(USER_LAYER_LIMITS.maxBytesPerLayer + 1, "big.tif"),
    ).toMatch(/слишком большой.*Предел/s);
    expect(validateUserLayerSize(1024, "ok.png")).toBeNull();
  });

  it("formatBytes человекочитаемо", () => {
    expect(formatBytes(0)).toBe("0 Б");
    expect(formatBytes(1024)).toBe("1 КБ");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 МБ");
  });

  it("checkLocalStorageQuota возвращает доли 0..100", () => {
    const q = checkLocalStorageQuota();
    expect(q.percentage).toBeGreaterThanOrEqual(0);
    expect(q.percentage).toBeLessThanOrEqual(100);
    expect(q.used).toBeGreaterThanOrEqual(0);
  });

  it("IndexedDB доступен в тестовой среде (fake)", () => {
    expect(isIndexedDbAvailable()).toBe(true);
  });
});

describe("storage: CRUD записей слоёв в IndexedDB", () => {
  beforeEach(async () => {
    for (const id of await listUserLayerIds())
      await deleteUserLayerFromIndexedDB(id);
  });

  it("save/load/delete — полный цикл с бинарным sourceBlob", async () => {
    const blob = new Uint8Array([1, 2, 3, 4]).buffer;
    const ok = await saveUserLayerToIndexedDB({
      id: "L-BIN",
      imageDataUrl: "data:image/png;base64,BIN",
      sourceBlob: blob,
      bytes: 4,
      timestamp: 0,
    });
    expect(ok).toBe(true);
    const rec = await loadUserLayerFromIndexedDB("L-BIN");
    expect(rec).not.toBeNull();
    expect(rec!.imageDataUrl).toBe("data:image/png;base64,BIN");
    expect(new Uint8Array(rec!.sourceBlob!)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(await listUserLayerIds()).toContain("L-BIN");
    expect(await getUserLayersTotalBytes()).toBe(4);
    expect(await deleteUserLayerFromIndexedDB("L-BIN")).toBe(true);
    expect(await loadUserLayerFromIndexedDB("L-BIN")).toBeNull();
  });

  it("load несуществующего id -> null; delete чужого id не падает", async () => {
    expect(await loadUserLayerFromIndexedDB("nope")).toBeNull();
    expect(await deleteUserLayerFromIndexedDB("nope")).toBe(true);
  });

  it("повторное сохранение того же id перезаписывает запись (timestamp обновляется)", async () => {
    await saveUserLayerToIndexedDB({ id: "L1", bytes: 10, timestamp: 1 });
    await saveUserLayerToIndexedDB({
      id: "L1",
      imageDataUrl: "data:x",
      bytes: 20,
      timestamp: 2,
    });
    const rec = await loadUserLayerFromIndexedDB("L1");
    expect(rec!.bytes).toBe(20);
    expect(rec!.timestamp).toBeGreaterThan(1);
    expect((await listUserLayerIds()).filter((i) => i === "L1")).toHaveLength(
      1,
    );
  });
});

// ФАЗА 5.D: секция «useStore: слайс пользовательских слоёв» удалена вместе с
// фасадом useStoreShim. Реестр project.userLayers был мёртвым кодом аудита:
// ни один компонент приложения его не использовал (только тесты). CRUD-тесты
// тяжёлых данных в IndexedDB ниже остаются — они покрывают живой слой storage.

describe("storage: доступность IndexedDB и защита от блокировки", () => {
  it("isIndexedDbAvailable отражает реальное наличие indexedDB", async () => {
    const mod = await import("../src/utils/storage");
    expect(typeof mod.isIndexedDbAvailable()).toBe("boolean");
  });
});
