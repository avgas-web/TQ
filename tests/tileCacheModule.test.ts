/**
 * T2: модульный LRU-кэш тайлов (src/utils/tileCache.ts)
 * Инварианты:
 *  - кэш переживает unmount компонента (модуль живёт вне React-дерева);
 *  - дедупликация in-flight запросов между инстансами (один Image на url);
 *  - refcount-отмена: release() одного потребителя НЕ прерывает общую загрузку,
 *    отменяется только последняя подписка;
 *  - crossOrigin='anonymous' сохранён (canvas-экспорт не taint'ится);
 *  - cache-hit мгновенный (без нового Image и без ожидания onload).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  acquireTile,
  peekTile,
  putTile,
  clearTileCache,
  isTileInflight,
  inflightCount,
} from "../src/utils/tileCache";

/* Мок Image: src выставляется — эмулируем асинхронный onload по requestAnimationFrame-подобному
   микрозадачному планировщику, которым управляем вручную через flush(). */
type ImgMock = {
  src: string;
  crossOrigin: string | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
};
const created: ImgMock[] = [];
let pendingLoads: ImgMock[] = [];

function makeImageMock(failUrls?: Set<string>) {
  return class FakeImage {
    src = "";
    crossOrigin: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      const self = this as unknown as ImgMock;
      created.push(self);
      Object.defineProperty(this, "src", {
        set(v: string) {
          (self as { _src: string })._src = v;
          // асинхронно «догружаем» — как сеть
          queueMicrotask(() => {
            if (!this.onload && !this.onerror) return; // снято cancel()
            if (failUrls && failUrls.has(v)) this.onerror?.();
            else this.onload?.();
          });
        },
        get() {
          return (self as { _src?: string })._src ?? "";
        },
      });
    }
  };
}

beforeEach(() => {
  created.length = 0;
  pendingLoads = [];
  clearTileCache();
  vi.stubGlobal("Image", makeImageMock());
});

describe("tileCache (T2)", () => {
  it("cache-hit мгновенный: второй acquireTile не создаёт новый Image", async () => {
    const url = "https://server.arcgisonline.com/tiles/1.png";
    const s1 = acquireTile(url);
    const img1 = await s1.done;
    expect(img1).not.toBeNull();
    expect(created.length).toBe(1);
    const s2 = acquireTile(url);
    const img2 = await s2.done;
    expect(img2).toBe(img1);
    expect(created.length).toBe(1); // сети не было
    expect(peekTile(url)).toBe(img1);
  });

  it("дедупликация in-flight: два потребителя одного url → один Image", async () => {
    const url = "https://server.arcgisonline.com/tiles/2.png";
    const a = acquireTile(url);
    const b = acquireTile(url);
    expect(isTileInflight(url)).toBe(true);
    expect(created.length).toBe(1);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra).toBe(rb);
    expect(inflightCount()).toBe(0);
  });

  it("refcount-отмена: release первого потребителя НЕ прерывает общую загрузку", async () => {
    const url = "https://server.arcgisonline.com/tiles/3.png";
    const a = acquireTile(url);
    const b = acquireTile(url);
    a.release(); // ушёл MapCanvas, остался MiniMapPanel
    const imgB = await b.done;
    expect(imgB).not.toBeNull(); // загрузка дожила до завершения
    expect(peekTile(url)).toBe(imgB);
  });

  it("refcount-отмена: последний release ДО завершения отменяет загрузку", async () => {
    const url = "https://server.arcgisonline.com/tiles/4.png";
    const a = acquireTile(url);
    a.release();
    const img = await a.done;
    expect(img).toBeNull(); // handle.cancel() → resolve(null)
    expect(isTileInflight(url)).toBe(false);
    expect(peekTile(url)).toBeUndefined(); // отменённая — не кэшируется как успех
  });

  it("кэш переживает 'unmount': модульные данные доступны после cleanup-сценария", async () => {
    const url = "https://server.arcgisonline.com/tiles/5.png";
    const s1 = acquireTile(url);
    const img = await s1.done;
    s1.release(); // имитация unmount MapCanvas: release не трогает settled-кэш
    expect(peekTile(url)).toBe(img);
    const s2 = acquireTile(url); // remount
    expect(await s2.done).toBe(img);
    expect(created.length).toBe(1); // повторной сети нет
  });

  it("crossOrigin='anonymous' сохраняется (canvas-экспорт не taint'ится)", async () => {
    const url = "https://server.arcgisonline.com/tiles/6.png";
    const s = acquireTile(url);
    await s.done;
    expect(created[0].crossOrigin).toBe("anonymous");
  });

  it("неудачная загрузка попадает в отрицательный кэш (null), слот не битый", async () => {
    vi.stubGlobal(
      "Image",
      makeImageMock(new Set(["https://bad.example/7.png"])),
    );
    const url = "https://bad.example/7.png";
    const s = acquireTile(url);
    const img = await s.done;
    expect(img).toBeNull();
    expect(peekTile(url)).toBeNull(); // кэшировано как «нет данных»
    const s2 = acquireTile(url); // cache-hit на null — мгновенно, без сети
    expect(await s2.done).toBeNull();
  });

  it("putTile/LRU: переполнение вытесняет самые старые записи", () => {
    for (let i = 0; i < 5; i++) putTile(`u${i}`, null);
    // cap по умолчанию 600 — все на месте
    expect(peekTile("u0")).toBeNull();
    clearTileCache();
    expect(peekTile("u0")).toBeUndefined();
  });
});
