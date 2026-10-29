// ─── Единый DOM-слой тайлов «как на openstreetmap.org» ──────────────────────
// КОПИЯ ПРИНЦИПА ОТОБРАЖЕНИЯ КАРТЫ РЕЖИМА ПЛАНИРОВАНИЯ (MapCanvas:
// tileLayerRef + positionTileLayer + syncTileDom), перенесённая для панелей
// режима мастера (MiniMapPanel). Ключевые отличия от прежней canvas-отрисовки
// тайлов в панелях:
//  • тайлы — настоящие <img>-элементы внутри абсолютно позиционированного div
//    ПОД канвасом оверлеев; позиция слоя обновляется одним CSS transform
//    напрямую (без перерисовки React и без drawImage по каждому тайлу);
//  • растр НЕ проходит через canvas-ресэмплирование — браузер размещает
//    нативные 256px-тайлы субпиксельно точно ⇒ нет «кривой загрузки», швов
//    и нечёткости, которые давала ручная сетка drawImage с округлениями;
//  • непрерывный зум: уровень сетки = round(zoom) (как Leaflet/osm.org),
//    масштаб слоя = 2^(zoom−level); выше нативного максимума провайдера
//    берётся ближайший нативный уровень и растягивается (maxNativeZoom);
//  • загрузка — очередь с лимитом параллельных, приоритетом тайлов от центра
//    экрана и дебаунсом во время жеста; при неудаче слот освобождается и
//    перезапрашивается (никаких битых <img>, держaщих соединения).
// Математика привязки вида — единая с pannelli.viewBox:
//   worldPx = canvasHeight · 2^zoom,  screen = (geoFrac − centerFrac)·worldPx + c/2,
// поэтому координатная связь «экран ⇔ гео» совпадает с канвасом оверлеев.
import { getOSMTileUrl, normalizeTileServer, TILE_PROVIDERS, type TileServerId } from './openStreetMap';
import { viewBox, type PanelView } from './pannelli';

const TILE_CSS = 256; // нативный размер тайла в CSS-px слоя уровня

export interface TileDomLayer {
  /** Обновить позицию/масштаб слоя по текущему виду (один CSS transform). */
  position(v: PanelView): void;
  /** Синхронизировать набор <img> с видимой областью + поставить в очередь недостающие. */
  sync(v: PanelView): void;
  /** Полный сброс: удалить все элементы и отменить незавершённые загрузки. */
  reset(): void;
  /** Отмена всех in-flight загрузок (cleanup компонента / смена сервера). */
  abortAll(): void;
}

interface LayerOptions {
  /** Смена сервера тайлов произошла (для инвалидации кэша вызывающим кодом). */
  onServerChange?(): void;
}

/**
 * Создаёт DOM-слой тайлов поверх контейнера `host` (позиционируется absolute
 * inset-0; канвас оверлеев должен лежать ВЫШЕ за счёт собственного z-index).
 * `getView` возвращает актуальный вид панели; `size` — измеренный размер окна
 * канваса в css-px; `server` — рабочий тайловый провайдер (legacy значения
 * нормализуются normalizeTileServer — те же URL, что у большой карты).
 */
export function createTileDomLayer(
  host: HTMLElement,
  getView: () => PanelView,
  getSize: () => { w: number; h: number },
  getServer: () => TileServerId | 'osm' | 'carto',
  opts: LayerOptions = {},
): TileDomLayer {
  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText =
    'position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;' +
    'transform-origin:0 0;pointer-events:none;z-index:0;background:#0f1729;';
  host.appendChild(layer);

  // Счётчик ЖИВЫХ загрузок этого слоя — наружу через getActiveLoads(). Тесты
  // стабильности (wizardFreeze) требуют, чтобы после unmount НЕ оставалось
  // ни одной незавершённой загрузки: destroy() обязан довести счётчик до нуля.
  let liveLoads = 0;

  // ── Состояние слоя (зеркало логики MapCanvas.syncTileDom/pump, но локальное) ──
  const els = new Map<string, HTMLImageElement>();   // url → <img> в DOM
  const loaded = new Set<string>();                  // успешно загруженные URL
  const pending = new Set<string>();                 // URL в полёте (дедупликация)
  let queue: string[] = [];
  let active = 0; // слоты очереди загрузки, занятые в данный момент
  const MAX_PARALLEL = 4;                            // щадим CDN суммарно по панелям
  const DEBOUNCE_MS = 120;                           // пауза очереди во время жеста
  let debounceTimer: number | null = null;
  let destroyed = false;
  let lastServerRaw = '';

  const inflight = new Map<string, Promise<void>>(); // url → промис загрузки img.src

  const removeEl = (url: string): void => {
    const el = els.get(url);
    if (el) { el.remove(); els.delete(url); }
  };

  /** Отменить незавершённую загрузку <img>: снять обработчики, освободить слот. */
  const cancelImgLoad = (url: string): void => {
    const p = inflight.get(url);
    if (!p) return;
    inflight.delete(url);
    // Снимаем DOM-обработчики — загрузка считается отменённой на уровне слоя
    // (settle больше не вызовется; слот active и pending освобождаются здесь).
    const el = els.get(url);
    if (el) { el.onload = null; el.onerror = null; }
    pending.delete(url);
    active = Math.max(0, active - 1);
    liveLoads = Math.max(0, liveLoads - 1); // ЖИВАЯ загрузка погашена (unmount-safe)
    void p.then(() => {
      const e = els.get(url);
      if (e && !loaded.has(url)) {
        try { e.removeAttribute('src'); } catch { /* noop */ }
      }
    });
  };

  const pump = (): void => {
    if (destroyed) return;
    while (active < MAX_PARALLEL && queue.length > 0) {
      const url = queue.shift() as string;
      const el = els.get(url);
      // Тайл уже ушёл с экрана или загружен — пропускаем без запроса
      if (!el || pending.has(url) || loaded.has(url)) continue;
      pending.add(url);
      active++;
      liveLoads++;
      const settle = (): void => {
        active--;
        pending.delete(url);
        inflight.delete(url);
        liveLoads = Math.max(0, liveLoads - 1);
        if (!destroyed) pump();
      };
      // «Разрешатель» хранится в inflight, чтобы cancelImgLoad мог дождаться
      // фактического завершения события браузера перед снятием src.
      let finish!: () => void;
      const gate = new Promise<void>((r) => { finish = r; });
      inflight.set(url, gate);
      el.onload = () => { loaded.add(url); finish(); settle(); };
      el.onerror = () => {
        // Неудача: слот освобождается (битый src не остаётся), при
        // следующей синхронизации тайл будет перезапрошен.
        loaded.delete(url);
        removeEl(url);
        finish();
        settle();
      };
      el.src = url;
    }
  };

  const enqueue = (urls: string[]): void => {
    if (urls.length === 0) return;
    for (const u of urls) if (!queue.includes(u)) queue.push(u);
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    // В покое — старт немедленно; сразу после жеста — короткий дебаунс,
    // чтобы быстро сменяемый вид не плодил лишних запросов к серверу.
    debounceTimer = window.setTimeout(() => { debounceTimer = null; pump(); }, active === 0 ? 0 : DEBOUNCE_MS);
  };

  const position = (v: PanelView): void => {
    const { w, h } = getSize();
    if (!(w > 0) || !(h > 0) || destroyed) return;
    const server = normalizeTileServer(getServer());
    const nativeMax = TILE_PROVIDERS[server].maxNativeZoom;
    const zoom = v.zoom;
    // Уровень сетки — ЦЕЛОЧИСЛЕННОЕ приближение текущего зума (round, как
    // Leaflet/osm.org): слой масштабируется на 2^(zoom−level) ⇒ непрерывный
    // плавный зум без «прыжков» между уровнями.
    const level = Math.max(3, Math.min(nativeMax, Math.round(zoom)));
    const n = Math.pow(2, level);
    // ЕДИНАЯ база привязки (паннели.viewBox): мир = h·2^zoom css-px.
    const vb = viewBox(v, w, h);
    const sPerPx = vb.wpx / n; // экранных px на world-пиксель УРОВНЯ level
    // Тайл (0,0) мира уровня находится во fract(v.fx·n) мира ⇒ его экранная
    // позиция: x = W/2 − (fx·n − floor(fx·n))·sPerPx (то же, что translate в
    // DOM-слое большой карты, только выведенное из mercator-долей центра).
    const tx0 = Math.floor(v.fx * n);
    const ty0 = Math.floor(v.fy * n);
    const baseX = w / 2 - (v.fx * n - tx0) * sPerPx;
    const baseY = h / 2 - (v.fy * n - ty0) * sPerPx;
    layer.style.width = `${w}px`;
    layer.style.height = `${h}px`;
    // Чёткость при увеличении (тот же фикс, что в режиме планирования):
    // scale > 1 (дробный зум вверх / растяжение выше нативного уровня) —
    // nearest-интерполяция вместо браузерного размытия; scale ≤ 1 оставляем
    // стандартное сглаживание (иначе алиасинг на детализированных тайлах).
    const scale = sPerPx / TILE_CSS;
    layer.style.imageRendering = scale > 1 ? 'pixelated' : 'auto';
    layer.style.transformOrigin = '0 0';
    layer.style.transform = `translate(${baseX}px, ${baseY}px) scale(${scale})`;
    // Сохраняем параметры для sync (та же формула — единый источник расчёта)
    posRef.level = level;
    posRef.n = n;
    posRef.tx0 = tx0;
    posRef.ty0 = ty0;
    posRef.sPerPx = sPerPx;
  };

  const posRef = { level: 3, n: 8, tx0: 0, ty0: 0, sPerPx: 1 };

  const sync = (v: PanelView): void => {
    if (destroyed) return;
    const { w, h } = getSize();
    if (!(w > 0) || !(h > 0)) return;
    const serverRaw = getServer();
    const server = normalizeTileServer(serverRaw);
    // Смена сервера — полный сброс слоя (URL'ы разных провайдеров непересекаемы)
    if (lastServerRaw !== '' && serverRaw !== lastServerRaw) {
      abortAll();
      for (const u of [...els.keys()]) removeEl(u);
      loaded.clear();
      opts.onServerChange?.();
    }
    lastServerRaw = serverRaw;
    position(v);
    const nativeMax = TILE_PROVIDERS[server].maxNativeZoom;
    const level = posRef.level;
    const n = posRef.n;
    const sPerPx = posRef.sPerPx;
    // Диапазон тайлов, покрывающий окно с запасом в 1 тайл со каждой стороны
    const cols = Math.ceil(w / sPerPx) + 1;
    const rows = Math.ceil(h / sPerPx) + 1;
    const keep = new Set<string>();
    const need: { url: string; x: number; y: number }[] = [];
    const cxw = posRef.tx0 + cols / 2;
    const cyw = posRef.ty0 + rows / 2;
    let budget = 400; // защита от аномальных видов
    for (let i = 0; i < cols && budget > 0; i++) {
      for (let j = 0; j < rows && budget > 0; j++) {
        const tx = posRef.tx0 + i;
        let ty = posRef.ty0 + j;
        if (tx < 0 || tx >= n) continue;
        if (ty < 0 || ty >= n) {
          // Вертикальная экстраполяция OSM (повторяем ближайший крайний ряд)
          ty = Math.max(0, Math.min(n - 1, ty));
        }
        budget--;
        // Выше нативного максимума провайдера — ближайший нативный уровень
        // и растяжение (maxNativeZoom, как Leaflet): берём тайл уровня
        // nativeMax из пропорционального индекса.
        const reqLevel = Math.min(level, nativeMax);
        const k = Math.pow(2, reqLevel - level); // ≥ 1: доля нативного тайла
        const rTx = Math.min(Math.pow(2, reqLevel) - 1, Math.floor(tx * k));
        const rTy = Math.min(Math.pow(2, reqLevel) - 1, Math.floor(ty * k));
        const url = getOSMTileUrl(reqLevel, rTx, rTy, server, 'scheme');
        keep.add(url);
        if (els.has(url)) continue;
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.draggable = false;
        img.style.position = 'absolute';
        // Позиция тайла в координатах «мира уровня» (слой масштабируется целиком)
        img.style.left = `${tx * TILE_CSS}px`;
        img.style.top = `${ty * TILE_CSS}px`;
        img.style.width = `${TILE_CSS}px`;
        img.style.height = `${TILE_CSS}px`;
        layer.appendChild(img);
        els.set(url, img);
        if (!pending.has(url) && !loaded.has(url)) need.push({ url, x: tx, y: ty });
      }
    }
    // Удаляем тайлы вне видимого набора (экономим DOM/память, отменяем полёт)
    for (const u of [...els.keys()]) {
      if (!keep.has(u)) { cancelImgLoad(u); removeEl(u); loaded.delete(u); }
    }
    // Приоритет ближних к центру экрана — карта «проявляется» из центра (osm.org)
    if (need.length > 0) {
      need.sort((a, b) => ((a.x - cxw) ** 2 + (a.y - cyw) ** 2) - ((b.x - cxw) ** 2 + (b.y - cyw) ** 2));
      enqueue(need.map((t) => t.url));
    }
  };

  const abortAll = (): void => {
    if (debounceTimer !== null) { window.clearTimeout(debounceTimer); debounceTimer = null; }
    queue = [];
    for (const u of [...inflight.keys()]) cancelImgLoad(u);
  };

  const reset = (): void => {
    abortAll();
    for (const u of [...els.keys()]) removeEl(u);
    loaded.clear();
    pending.clear();
    active = 0;
  };

  return { position, sync, reset, abortAll };
}
