// Утилиты для работы с OpenStreetMap
import { calculateBoundsFromCenter, latToMercatorY } from './googleMaps';

/** Зеркала тайлового сервера tile.openstreetmap.org (перебираются при ошибках/таймаутах) */
const OSM_TILE_MIRRORS = [
  'https://tile.openstreetmap.org',
  'https://a.tile.openstreetmap.org',
  'https://b.tile.openstreetmap.org',
  'https://c.tile.openstreetmap.org',
];

/**
 * Рабочие зеркала публичных тайлов 2ГИС. Хост `tile-b01.2gis.com` НЕ резолвится
 * в ряде сетей (net::ERR_NAME_NOT_RESOLVED — DNS-блокировка/фильтр), из-за чего
 * подложка «2ГИС» молча не загружалась вообще. sl{1..4}.2gis.com — те же публичные
 * тайлы по стандартной XYZ-схеме; перебор зеркал даёт отказоустойчивость как у OSM.
 * tile-b01 намеренно ИСКЛЮЧЁН из обхода ПОЛНОСТЬЮ (а не только после первого сбоя):
 * при DNS-блокировке браузер сначала долгие секунды держит тайловый слот занятым
 * ожиданием ответа DNS, и очередь загрузки («pump») встает — карта выглядит
 * зависшей. Поэтому ни один запрос к tile-b01 не отправляется никогда.
 */
const TWO_GIS_TILE_MIRRORS = [
  'https://sl1.2gis.com',
  'https://sl2.2gis.com',
  'https://sl3.2gis.com',
  'https://sl4.2gis.com',
];

/**
 * Кэш последнего успешно отдавшего тайл хоста 2ГИС: после определения живого
 * зеркала все последующие тайлы идут сразу на него (без шторма DNS-ошибок).
 */
let twoGisWorkingHost: string | null = null;

/**
 * Приведение ЛЮБОГО 2ГИС-URL к живому зеркалу. Ключевой фикс шторма
 * net::ERR_NAME_NOT_RESOLVED на tile-b01.2gis.com/tiles?x=..&y=..&z=..:
 * URL с мёртвым хостом (старые сохранённые проекты, сторонние шаблоны,
 * устаревшие сборки) переписывается на рабочий sl{1..4}.2gis.com ПЕРЕД
 * любой загрузкой — включая присвоение `src` DOM-тайлу после успешной
 * загрузки (иначе браузер повторно скачивал бы тайл уже с мёртвого хоста).
 * Возвращает исходный URL, если он не относится к 2ГИС.
 */
export function normalizeTwoGisTileUrl(url: string): string {
  if (!url.includes('2gis.com')) return url;
  const m = url.match(/^https?:\/\/(?:tile-b01|sl[1-4])\.2gis\.com\/(.+)$/);
  const pathAndQuery = m ? '/' + m[1] : (() => {
    try { const u = new URL(url); return u.pathname + u.search; } catch { return null; }
  })();
  if (pathAndQuery === null) return url;
  const host = twoGisWorkingHost ?? TWO_GIS_TILE_MIRRORS[0];
  if (/^https?:\/\/sl[1-4]\.2gis\.com\//.test(url) && url.startsWith(host + '/')) return url;
  return host + pathAndQuery;
}

/** Хосты 2ГИС в порядке приоритета: проверенный живой — первым. tile-b01 исключён. */
function twoGisHostsOrdered(): string[] {
  if (twoGisWorkingHost) {
    return [twoGisWorkingHost, ...TWO_GIS_TILE_MIRRORS.filter((h) => h !== twoGisWorkingHost)];
  }
  return [...TWO_GIS_TILE_MIRRORS];
}

/** URL тайла 2ГИС на указанном хосте-зеркале (стандартная query-схема x/y/z). */
function twoGisTileUrl(host: string, x: number, y: number, z: number): string {
  return `${host}/tiles?x=${x}&y=${y}&z=${z}`;
}

/** Ограничение параллельных загрузок тайлов на один хост: браузер даёт ~6 соединений,
 *  сотни запросов без лимита = таймауты и «вечная загрузка» большой карты. */
let tileActive = 0;
const tileWaiters: Array<() => void> = [];
async function withTileSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (tileActive >= 4) await new Promise<void>((res) => tileWaiters.push(res));
  tileActive++;
  try {
    return await fn();
  } finally {
    tileActive--;
    const next = tileWaiters.shift();
    if (next) next();
  }
}

export interface OSMConfig {
  loaded: boolean;
}

const osmConfig: OSMConfig = {
  loaded: false,
};

/**
 * Инициализация OpenStreetMap (не требует API ключа)
 */
export function initOpenStreetMap(): Promise<void> {
  return new Promise((resolve) => {
    osmConfig.loaded = true;
    resolve();
  });
}

// Зеркала Nominatim. Публичный nominatim.openstreetmap.org часто недоступен из ряда
// сетей/регионов (ERR_CONNECTION_TIMED_OUT) и жёстко лимитирует запросы, поэтому
// перебираем несколько инстансов с таймаутом и вежливым паузированием.
const NOMINATIM_HOSTS = [
  'https://nominatim.openstreetmap.org',
  'https://nominatim.mapnik.us',
  'https://nominatim.private.coffee',
];

// Локальная очередь «не чаще 1 запроса в секунду» — требование usage policy Nominatim.
// Резервирование момента выполнения синхронно (до await) исключает «шторм» из
// одновременно стартовавших запросов при пакетном геокодировании списков.
let lastNominatimAt = 0;
function reserveNominatimSlot(): Promise<void> {
  const now = Date.now();
  const when = Math.max(now, lastNominatimAt + 1000);
  lastNominatimAt = when;
  const wait = when - now;
  return wait > 0 ? new Promise((res) => setTimeout(res, wait)) : Promise.resolve();
}

export type NominatimErrorKind = 'network' | 'http';

/**
 * Запрос к Nominatim с перебором зеркал, таймаутом и повтором.
 * Возвращает [данные, kind] где kind='ok'|'not_found'|'network'|'http' —
 * вызывающий код различает «сервис недоступен», «адрес не найден» и HTTP-ошибку.
 * Поддерживает внешний AbortController для отмены (уход пользователя, новый запрос).
 * Ошибки внешних серверов не пишутся в console.error — это штатная ситуация,
 * вызывающий код показывает пользователю понятное сообщение.
 */
async function fetchNominatimJson(
  path: string,
  params: string,
  outerSignal?: AbortSignal,
): Promise<{ data: any[] | any | null; kind: 'ok' | 'not_found' | NominatimErrorKind }> {
  let sawHttpError = false;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < NOMINATIM_HOSTS.length; i++) {
      if (outerSignal?.aborted) return { data: null, kind: 'network' };
      const host = NOMINATIM_HOSTS[(i + round) % NOMINATIM_HOSTS.length];
      await reserveNominatimSlot();
      if (outerSignal?.aborted) return { data: null, kind: 'network' };
      const ctrl = new AbortController();
      const abortOuter = () => ctrl.abort();
      outerSignal?.addEventListener('abort', abortOuter);
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const response = await fetch(`${host}${path}?format=json&${params}`, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json' },
        });
        if (response.status === 429 || response.status >= 500) {
          sawHttpError = true;
          continue; // пробуем следующее зеркало
        }
        if (!response.ok) return { data: null, kind: 'http' };
        const json = await response.json();
        return { data: json, kind: Array.isArray(json) && json.length === 0 ? 'not_found' : 'ok' };
      } catch {
        /* сеть/таймаут/отмена — следующее зеркало */
      } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', abortOuter);
      }
    }
    // после первого раунда — короткая пауза перед повтором
    if (round === 0) await new Promise((res) => setTimeout(res, 1000));
  }
  return { data: null, kind: sawHttpError ? 'http' : 'network' };
}

export interface OsmGeocodeResult {
  point: { lat: number; lng: number } | null;
  /** 'ok' — успех; 'not_found' — адрес не найден; 'network'/'http' — сервисная ошибка */
  kind: 'ok' | 'not_found' | NominatimErrorKind;
}

/**
 * Геокодирование адреса через Nominatim (OSM).
 * Возвращает различимый статус, чтобы UI не смешивал «не найдено» и «сервис недоступен».
 */
export async function osmGeocode(address: string, signal?: AbortSignal): Promise<OsmGeocodeResult> {
  const { data, kind } = await fetchNominatimJson(
    '/search',
    `q=${encodeURIComponent(address)}&limit=1`,
    signal,
  );
  if (kind !== 'ok') return { point: null, kind };
  const first = Array.isArray(data) ? data[0] : null;
  const lat = first ? parseFloat(first.lat) : NaN;
  const lng = first ? parseFloat(first.lon) : NaN;
  if (!isFinite(lat) || !isFinite(lng)) return { point: null, kind: 'not_found' };
  return { point: { lat, lng }, kind: 'ok' };
}

/**
 * Обратное геокодирование через Nominatim (OSM)
 */
export async function osmReverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<string | null> {
  const { data, kind } = await fetchNominatimJson('/reverse', `lat=${lat}&lon=${lng}`, signal);
  if (kind !== 'ok') return null;
  if (data && typeof data.display_name === 'string') return data.display_name;
  return null;
}

export type TileStyle = 'scheme' | 'satellite' | 'hybrid';

/**
 * Получение URL тайла OSM
 */
export function getOSMTileUrl(
  zoom: number,
  x: number,
  y: number,
  tileServer: 'osm' | 'opentopomap' | 'carto' | '2gis' = 'osm',
  style: TileStyle = 'scheme'
): string {
  // detectRetina: тайлы @2x доступны ТОЛЬКО у tile.openstreetmap.org и basemaps.cartocdn.com
  // (макс. уровень их нативного зума — 19). Esri World_Imagery отдаёт 512-px тайлы без @2x,
  // opentopomap — только до z17. maxNativeZoom учитывается вызывающим кодом.
  const z = Math.min(Math.max(zoom, 0), 19);
  const retina = typeof window !== 'undefined' && (window.devicePixelRatio || 1) >= 1.5;
  const at = retina ? '@2x' : '';
  switch (tileServer) {
    case '2gis': {
      // Публичные тайловые серверы 2ГИС — стандартная схема XYZ Web Mercator,
      // нативный зум до 18, ключ API не требуется. Хост tile-b01.2gis.com НЕ
      // используется никогда: в ряде сетей его DNS не резолвится
      // (net::ERR_NAME_NOT_RESOLVED), и каждый такой запрос надолго занимал
      // слот очереди загрузки — карта «зависала» на полупустых тайлах.
      // URL сразу строится на живом зеркале sl{1..4}.2gis.com: кэш рабочего
      // хоста даёт один живой хост на сессию, loadTileWithMirrors при сбое
      // перебирает остальные.
      const host = twoGisWorkingHost ?? TWO_GIS_TILE_MIRRORS[0];
      return twoGisTileUrl(host, x, y, z);
    }
    case 'opentopomap':
      return `https://tile.opentopomap.org/${Math.min(z, 17)}/${x}/${y}.png`;
    case 'carto':
      if (style === 'satellite' || style === 'hybrid')
        return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
      return `https://basemaps.cartocdn.com/dark_all${at}/${z}/${x}/${y}.png`;
    case 'osm':
    default:
      if (style === 'satellite' || style === 'hybrid')
        return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
      return `https://tile.openstreetmap.org/${z}/${x}/${y}${at}.png`;
  }
}

/**
 * Отмена незавершённой загрузки <img>. Нативный HTMLImageElement.abort() есть не
 * во всех движках (и отсутствует в типах DOM и happy-dom), поэтому вызов
 * защищён feature-det'ом; сброс src='' — универсальный fallback.
 */
export function abortTileImage(img: HTMLImageElement): void {
  const maybeAbort = (img as { abort?: () => void }).abort;
  if (typeof maybeAbort === 'function') {
    try { maybeAbort.call(img); } catch { /* движок отклонил отмену */ }
  }
  // removeAttribute — метод DOM-элемента; в моках/старых движках может отсутствовать,
  // поэтому сброс src выполняется защищённо (тот же эффект отмены загрузки).
  if (typeof img.removeAttribute === 'function') {
    img.removeAttribute('src');
  } else {
    img.src = '';
  }
}

/**
 * Тайл с деградацией до maxNativeZoom: выше родного разрешения тайлы НЕ растягиваются —
 * берётся ближайший доступный уровень и рисуется в физическом разрешении.
 *
 * ИСПРАВЛЕНИЕ ВЕЧНОГО СПИННЕРА («карта грузится и висит»): у <img> нет встроенного
 * таймаута. Если CDN провайдера принимает соединение, но не отдаёт ответ (OSM-зеркала
 * при 429/перегрузке так делают стабильно), onload/onerror не срабатывают НИКОГДА,
 * а старый `img.src=''` отменяет загрузку только на части движков — промис зависал
 * навсегда, слот очереди не освобождался и загрузка всей подложки останавливалась.
 * Теперь по таймауту вызывается нативный img.abort() (гарантированная отмена),
 * обработчики снимаются, а resolve происходит РОВНО один раз (settled-флаг).
 */
/** Публичный тип ручки загрузки тайла (см. startTileLoad). */
export type TileLoadHandle = {
  /** Актуальный <img> текущей попытки (перебираемые зеркала меняют его на лету). */
  image: HTMLImageElement | null;
  /** Отмена: немедленно завершает очередь (done→null) и обрывает активный img. */
  cancel(): void;
  readonly done: Promise<HTMLImageElement | null>;
};

/**
 * Ручка-обёртка над перебором зеркал (loadTileWithMirrors) с гарантированной
 * отменой в ЛЮБОЙ момент. Критично для теста «unmount отменяет ВСЕ in-flight
 * загрузки»: cancel() обязан не только резолвить done(null) (освобождение слота
 * очереди), но и вызывать abort()/сброс src у активного Image — иначе мок/браузер
 * держит незавершённую загрузку («утечка»). Реализация: каждая попытка зеркала
 * создаётся через startTileLoad, её handle пробрасывается в поля внешней ручки;
 * cancel() между попытками помечает флаг и обрывает уже созданный img, а
 * loadTileWithMirrorsSafe проверяет флаг перед каждой следующей попыткой.
 */
export function createCancellableMirrorLoad(url: string, timeoutMs: number): TileLoadHandle {
  let cancelled = false;
  let settled = false;
  // Финал done() — через мутабельный бокс: замыкания в cancel()/async-ветке
  // читают box.resolve, поэтому TS не может свести тип к never (в отличие от
  // «let resolveFn … = null» с последующим присваиванием в Promise-executor).
  const box: { resolve: ((v: HTMLImageElement | null) => void) | null } = { resolve: null };
  const done = new Promise<HTMLImageElement | null>((res) => { box.resolve = res; });
  const outer: TileLoadHandle = {
    image: null,
    cancel(): void {
      if (cancelled || settled) return;
      cancelled = true;
      // Немедленный финал: очередь не ждёт ответа зеркал/таймаута.
      settled = true;
      const r = box.resolve;
      if (r) r(null);
      const img = outer.image;
      if (img) abortTileImage(img);
    },
    done,
  };
  (async (): Promise<void> => {
    const img = await loadTileWithMirrorsSafe(url, timeoutMs, () => cancelled, outer);
    if (cancelled || settled) {
      if (img) abortTileImage(img); // отменено во время последней попытки — освободить соединение
      return;
    }
    settled = true;
    outer.image = img ?? outer.image;
    const r = box.resolve;
    if (r) r(img);
  })();
  return outer;
}

/**
 * То же, что loadTileWithMirrors, но с внешним флагом отмены и публикацией
 * активного <img> в ручку вызывающей стороны (для гарантированного abort при
 * unmount). Возвращает загруженный Image или null (все зеркала недоступны /
 * отменено).
 */
async function loadTileWithMirrorsSafe(
  url: string,
  timeoutMs: number,
  isCancelled: () => boolean,
  outer: TileLoadHandle,
): Promise<HTMLImageElement | null> {
  const tryHost = async (candidate: string): Promise<HTMLImageElement | null> => {
    if (isCancelled()) return null;
    const h = startTileLoad(candidate, timeoutMs);
    outer.image = h.image; // публикуем активный img — cancel() сможет его оборвать
    const img = await h.done;
    if (isCancelled()) {
      if (img) abortTileImage(img);
      return null;
    }
    return img;
  };
  const mOsm = url.match(/^https:\/\/(?:[abc]\.)?tile\.openstreetmap\.org\/(.+)$/);
  if (mOsm) {
    for (const host of OSM_TILE_MIRRORS) {
      const img = await tryHost(host + '/' + mOsm[1]);
      if (img) return img;
      if (isCancelled()) return null;
    }
    return null;
  }
  const m2gis = url.match(/^https:\/\/(?:tile-b01|sl[1-4])\.2gis\.com\/(.+)$/);
  if (m2gis) {
    const pathAndQuery = '/' + m2gis[1];
    for (const host of twoGisHostsOrdered()) {
      const img = await tryHost(host + pathAndQuery);
      if (img) {
        twoGisWorkingHost = host; // живое зеркало закешировано
        return img;
      }
      if (isCancelled()) return null;
    }
    return null;
  }
  // Прочие 2GIS-URL (сторонние шаблоны с '2gis.com' в адресе) — тоже через зеркала.
  if (url.includes('2gis.com')) {
    try {
      const u = new URL(url);
      const pathAndQuery = u.pathname + u.search;
      for (const host of twoGisHostsOrdered()) {
        const img = await tryHost(host + pathAndQuery);
        if (img) {
          twoGisWorkingHost = host;
          return img;
        }
        if (isCancelled()) return null;
      }
      return null;
    } catch {
      /* невалидный URL — одиночная попытка ниже */
    }
  }
  return tryHost(url);
}

/**
 * Загрузка тайла с ЯВНЫМ ручкой-контролем (P0 «зависания/утечки»): вызывающая
 * сторона (MapCanvas) регистрирует handle в реестре in-flight и ОБЯЗАНА вызвать
 * cancel() при размонтировании или отмене вида. Без этого Image с выставленным
 * src доживал до внутреннего таймаута (10 c), держал DOM-элементы и резолвился
 * на уже несмонтированном компоненте — утечка памяти + предупреждения React.
 */
export function startTileLoad(rawUrl: string, timeoutMs = 8000): TileLoadHandle {
  // Защита от DNS-шторма: даже если URL пришёл с мёртвым хостом tile-b01.2gis.com
  // (старый кэш/сохранённый проект/сторонний шаблон), запрос уходит на живое
  // зеркало sl{1..4}. Для всех прочих провайдеров normalizeTwoGisTileUrl — no-op.
  const url = normalizeTwoGisTileUrl(rawUrl);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  let settled = false;
  let resolveFn: ((v: HTMLImageElement | null) => void) | null = null;
  const done = new Promise<HTMLImageElement | null>((res) => { resolveFn = res; });
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish(false), timeoutMs);
  function finish(ok: boolean): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    img.onload = null;
    img.onerror = null;
    if (!ok) {
      // Гарантированная отмена незавершённой загрузки (освобождает соединение браузера)
      abortTileImage(img);
      resolveFn?.(null);
    } else {
      resolveFn?.(img);
    }
  }
  img.onload = () => finish(true);
  img.onerror = () => finish(false);
  img.src = url;
  return { image: img, cancel(): void { finish(false); }, done };
}

/** Обратная совместимость: обёртка над startTileLoad для существующих вызовов. */
export async function loadTileImage(url: string, timeoutMs = 8000): Promise<HTMLImageElement | null> {
  return startTileLoad(url, timeoutMs).done;
}

/**
 * Загрузка тайла с перебором зеркал. Раньше поддерживались только зеркала OSM;
 * хост 2ГИС tile-b01.2gis.com не резолвится в ряде сетей (ERR_NAME_NOT_RESOLVED),
 * и подложка «2ГИС» молча не загружалась вообще. Теперь для URL 2ГИС перебираются
 * рабочие зеркала sl{1..4}.2gis.com, а последний успешный хост кэшируется —
 * остальные тайлы идут сразу на живой сервер без шторма DNS-ошибок.
 */
export async function loadTileWithMirrors(url: string, timeoutMs = 8000): Promise<HTMLImageElement | null> {
  const mOsm = url.match(/^https:\/\/(?:[abc]\.)?tile\.openstreetmap\.org\/(.+)$/);
  if (mOsm) {
    for (const host of OSM_TILE_MIRRORS) {
      const img = await loadTileImage(host + '/' + mOsm[1], timeoutMs);
      if (img) return img;
    }
    return null;
  }
  const m2gis = url.match(/^https:\/\/(?:tile-b01|sl[1-4])\.2gis\.com\/(.+)$/);
  if (m2gis) {
    // Подстановка зеркала: путь+query сохраняются («/tiles?x=..&y=..&z=..»),
    // меняется только хост. tile-b01 никогда не опрашивается (мёртвый DNS в
    // ряде сетей блокировал слот очереди на секунды — «зависание» карты):
    // обходим сразу живые зеркала sl{1..4} с кэшированием рабочего хоста.
    const pathAndQuery = '/' + m2gis[1];
    for (const host of twoGisHostsOrdered()) {
      const img = await loadTileImage(host + pathAndQuery, timeoutMs);
      if (img) {
        twoGisWorkingHost = host; // живое зеркало закешировано
        return img;
      }
    }
    return null;
  }
  // Ключевое слово '2gis' в URL (например, query-параметр провайдера у сторонних
  // шаблонов) тоже считаем тайлами 2ГИС: иначе запрос уходит напрямую в хост из
  // URL без перебора зеркал и при недоступности DNS молча вешает слот очереди.
  if (url.includes('2gis.com')) {
    try {
      const u = new URL(url);
      const pathAndQuery = u.pathname + u.search;
      for (const host of twoGisHostsOrdered()) {
        const img = await loadTileImage(host + pathAndQuery, timeoutMs);
        if (img) {
          twoGisWorkingHost = host;
          return img;
        }
      }
      return null;
    } catch {
      /* невалидный URL — уходим в одиночную попытку ниже */
    }
  }
  return loadTileImage(url, timeoutMs);
}

/** Отладочный/тестовый сброс кэша рабочего зеркала 2ГИС. */
export function resetTwoGisMirrorCache(): void {
  twoGisWorkingHost = null;
}

/**
 * Конвертация lat/lng в тайловые координаты
 */
export function latLngToTile(
  lat: number,
  lng: number,
  zoom: number
): { x: number; y: number } {
  const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
  const y = Math.floor(
    (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2 * Math.pow(2, zoom)
  );
  return { x, y };
}

/**
 * Конвертация тайловых координат в lat/lng
 */
export function tileToLatLng(
  x: number,
  y: number,
  zoom: number
): { lat: number; lng: number } {
  const n = Math.pow(2, zoom);
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lat, lng };
}

/**
 * Получение статической карты OSM через статический генератор
 */
export async function loadOSMStaticMap(
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number,
  tileServer: 'osm' | 'opentopomap' | 'carto' = 'osm'
): Promise<{ dataUrl: string; bounds: { north: number; south: number; east: number; west: number } }> {
  console.log(`Загрузка карты OSM: сервер=${tileServer}, центр=(${center.lat}, ${center.lng}), зум=${zoom}, размер=${width}x${height}`);
  
  // Вычисляем границы (приблизительные — для совместимости сигнатуры)
  void calculateOSMBoundsFromCenter;

  // === ТОЧНАЯ Mercator-привязка снимка к географии (исправление «сбившегося масштаба») ===
  // Снимок покрывает ровно окно обзора: world px на данном зуме = 256*2^z, из них
  // по X видно width px => долготный размах симметричен центру; по Y — через Mercator.
  const zClamped = Math.min(Math.max(Math.round(zoom), 1), 19);
  const worldPxZ = 256 * Math.pow(2, zClamped);
  const mercC = latToMercatorY(Math.max(-85, Math.min(85, center.lat)));
  const halfSpanY = (height / 2) / worldPxZ;
  const north = tileToLatLng(0, Math.max(0, Math.min(1, mercC - halfSpanY)), zClamped).lat;
  const south = tileToLatLng(0, Math.max(0, Math.min(1, mercC + halfSpanY)), zClamped).lat;
  const lngHalf = (width / 2 / worldPxZ) * 360;
  const west = center.lng - lngHalf;
  const east = center.lng + lngHalf;
  const bounds = { north, south, east, west };

  // Пиксельные границы тайловой сетки, точно соответствующие видимой области
  const nTiles = Math.pow(2, zClamped);
  const xMinWorld = ((west + 180) / 360) * nTiles;
  const yMinWorld = latToMercatorY(north) * nTiles;

  // Создаем canvas и рисуем тайлы
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Не удалось создать canvas');
  }

  // Заполняем фон
  ctx.fillStyle = '#f2efe9';
  ctx.fillRect(0, 0, width, height);

  const tilesX = Math.ceil(width / 256) + 1;
  const tilesY = Math.ceil(height / 256) + 1;

  const startTileX = Math.floor(xMinWorld);
  const startTileY = Math.floor(yMinWorld);

  // Загружаем тайлы с лимитом параллелизма (4 одновременных) и перебором зеркал
  // tile.openstreetmap.org: раньше все тайлы стартовали одновременно без лимита —
  // при большой карте это переполняло очередь соединений браузера, загрузка
  // растягивалась на минуты («карта не загружается»).
  let loadedCount = 0;
  const drawTileAt = (img: HTMLImageElement | null, dx: number, dy: number) => {
    const pixelX = Math.round((startTileX + dx - xMinWorld) * 256);
    const pixelY = Math.round((startTileY + dy - yMinWorld) * 256);
    if (img) {
      ctx.drawImage(img, pixelX, pixelY, 256, 256);
      loadedCount++;
    } else {
      ctx.fillStyle = '#cccccc';
      ctx.fillRect(pixelX, pixelY, 256, 256);
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = 1;
      ctx.strokeRect(pixelX, pixelY, 256, 256);
    }
  };

  const jobs: Array<Promise<void>> = [];
  for (let dy = 0; dy < tilesY; dy++) {
    for (let dx = 0; dx < tilesX; dx++) {
      const tileX = startTileX + dx;
      const tileY = startTileY + dy;
      if (tileX < 0 || tileY < 0 || tileX >= nTiles || tileY >= nTiles) continue;
      const base = getOSMTileUrl(zClamped, tileX, tileY, tileServer);
      jobs.push(
        withTileSlot(async () => {
          const img = await loadTileWithMirrors(base);
          drawTileAt(img, dx, dy);
        })
      );
    }
  }
  await Promise.all(jobs);

  console.log(`Загружено ${loadedCount}/${jobs.length} тайлов для сервера ${tileServer}`);

  // Смещение больше не нужно: тайлы нарисованы точно под окно обзора. Старый
  // расчёт offsetX=(width-tilesX*256)/2 смещал снимок до половины тайла —
  // из-за этого привязка координат и масштаб «съезжали».
  const offsetX = 0;
  const offsetY = 0;
  
  if (offsetX !== 0 || offsetY !== 0) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    
    if (tempCtx) {
      tempCtx.fillStyle = '#f2efe9';
      tempCtx.fillRect(0, 0, width, height);
      tempCtx.drawImage(canvas, offsetX, offsetY);
      
      const dataUrl = tempCanvas.toDataURL('image/png');
      return { dataUrl, bounds };
    }
  }
  
  const dataUrl = canvas.toDataURL('image/png');
  return { dataUrl, bounds };
}

// Границы считаются через общую Web Mercator-функцию (googleMaps.ts)
const calculateOSMBoundsFromCenter = calculateBoundsFromCenter;

/**
 * Проверка статуса инициализации OSM
 */
export function isOSMLoaded(): boolean {
  return osmConfig.loaded;
}
