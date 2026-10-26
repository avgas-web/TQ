// Утилиты для работы с OpenStreetMap
import { calculateBoundsFromCenter, latToMercatorY } from './googleMaps';

/* ============================================================
   ТАЙЛОВЫЕ СЕРВЕРЫ — по аудиту audit/index.fixed.html:
   tile.openstreetmap.org и Carto (basemaps.cartocdn.com) УДАЛЕНЫ
   намеренно: основной OSM отдаёт 403 по Referer/User-Agent для
   github.io, Carto требует ключ. Оставлены только HTTPS-серверы
   без API-ключа, не блокирующие github.io:
   Esri World Street Map (стиль по умолчанию), Esri World Imagery,
   OSM France (osmfr/hot), OSM Germany, OpenTopoMap, CyclOSM.
   maxZoom/maxNativeZoom и attribution заданы для каждого слоя.
   ============================================================ */

export type TileServerId =
  | 'esri'          // Esri World Street Map — самый стабильный, стиль по умолчанию
  | 'esri-sat'      // Esri World Imagery (спутник)
  | 'osmfr'         // OSM France (стандартная схема)
  | 'hot'           // OSM France (гуманитарный HOT)
  | 'osmde'         // OSM Germany
  | 'opentopomap'   // OpenTopoMap (топографический)
  | 'cyclosm';      // CyclOSM (велосипедный)

export interface TileProviderInfo {
  /** Человекочитаемое название стиля (для UI) */
  label: string;
  /** Нативный максимум тайлов (выше — только растяжение, не поднимаемся) */
  maxNativeZoom: number;
  /** Верхняя граница зума в UI */
  maxZoom: number;
  attribution: string;
}

const OSM_ATTR = '© OpenStreetMap contributors';

export const TILE_PROVIDERS: Record<TileServerId, TileProviderInfo> = {
  esri:        { label: 'Esri — улицы (стабильный)', maxNativeZoom: 19, maxZoom: 19, attribution: 'Tiles © Esri' },
  'esri-sat':  { label: 'Esri — спутник',            maxNativeZoom: 19, maxZoom: 19, attribution: 'Tiles © Esri' },
  osmfr:       { label: 'OSM France (стандарт)',     maxNativeZoom: 19, maxZoom: 19, attribution: `${OSM_ATTR} | OSM France` },
  hot:         { label: 'OSM France (гуманитарный)', maxNativeZoom: 19, maxZoom: 19, attribution: `${OSM_ATTR} | HOT France` },
  osmde:       { label: 'OSM Germany',               maxNativeZoom: 17, maxZoom: 18, attribution: `${OSM_ATTR} | OSM Germany` },
  opentopomap: { label: 'OpenTopoMap',               maxNativeZoom: 17, maxZoom: 17, attribution: `${OSM_ATTR} | OpenTopoMap (CC-BY-SA)` },
  cyclosm:     { label: 'CyclOSM',                   maxNativeZoom: 19, maxZoom: 20, attribution: `${OSM_ATTR} | CyclOSM` },
};

/** Порядок стилей в выпадающих списках UI */
export const TILE_SERVER_ORDER: TileServerId[] = ['esri', 'esri-sat', 'osmfr', 'hot', 'osmde', 'opentopomap', 'cyclosm'];

/** Стиль подложки по умолчанию — Esri World Street Map (пункт B аудита) */
export const DEFAULT_TILE_SERVER: TileServerId = 'esri';

/** Нормализация значения из стора/импорта/старых сохранений → рабочий провайдер.
 *  Legacy-значения ('osm', 'carto') маппятся на совместимые рабочие серверы:
 *  'osm' → Esri Street (та же «уличная схема», z19), 'carto' → OSM France. */
export function normalizeTileServer(v: unknown): TileServerId {
  if (typeof v === 'string' && (v in TILE_PROVIDERS)) return v as TileServerId;
  if (v === 'carto') return 'osmfr';
  return DEFAULT_TILE_SERVER; // 'osm' и всё неизвестное
}

/** Зеркала-фоллбэки для Esri (при недоступности одного хоста). */
const ESRI_MIRRORS = [
  'https://server.arcgisonline.com',
  'https://services.arcgisonline.com',
];

/** URL тайла для любого рабочего провайдера (без нормализации зума вызывающим кодом). */
function tileUrlFor(server: TileServerId, z: number, x: number, y: number): string {
  switch (server) {
    case 'esri':        return esriUrl(ESRI_MIRRORS[0], 'World_Street_Map', z, x, y);
    case 'esri-sat':    return esriUrl(ESRI_MIRRORS[0], 'World_Imagery', z, x, y);
    case 'osmfr':       return `https://a.tile.openstreetmap.fr/osmfr/${z}/${x}/${y}.png`;
    case 'hot':         return `https://a.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`;
    case 'osmde':       return `https://tile.openstreetmap.de/${z}/${x}/${y}.png`;
    case 'opentopomap': return `https://a.tile.opentopomap.org/${z}/${x}/${y}.png`;
    case 'cyclosm':     return `https://a.tile-cyclosm.openstreetmap.fr/cyclosm/${z}/${x}/${y}.png`;
    default:            return esriUrl(ESRI_MIRRORS[0], 'World_Street_Map', z, x, y);
  }
}

/** URL тайла для Esri-провайдеров с перебором зеркал */
function esriUrl(host: string, service: string, z: number, x: number, y: number): string {
  return `${host}/ArcGIS/rest/services/${service}/MapServer/tile/${z}/${y}/${x}`; // у Esri порядок z/y/x
}

/** Все варианты URL одного тайла (зеркала) — пустой массив, если сервер не Esri */
export function getTileUrlVariants(
  zoom: number, x: number, y: number,
  tileServer: TileServerId = DEFAULT_TILE_SERVER,
): string[] {
  const z = Math.min(Math.max(Math.round(zoom), 0), 19);
  if (tileServer === 'esri')
    return ESRI_MIRRORS.map((h) => esriUrl(h, 'World_Street_Map', z, x, y));
  if (tileServer === 'esri-sat')
    return ESRI_MIRRORS.map((h) => esriUrl(h, 'World_Imagery', z, x, y));
  return [];
}

/** Варианты URL одного тайла для ЛЮБОГО рабочего провайдера (Esri — с зеркалами).
 *  Отдача выше maxNativeZoom («как Leaflet»: ближайший нативный уровень + растяжение)
 *  остаётся на стороне вызывающего кода. */
export function getTileUrlVariantsFor(
  server: TileServerId | 'osm' | 'carto',
  zoom: number, x: number, y: number,
): string[] {
  const s = normalizeTileServer(server);
  const z = Math.min(Math.max(Math.round(zoom), 0), 19);
  if (s === 'esri') return ESRI_MIRRORS.map((h) => esriUrl(h, 'World_Street_Map', z, x, y));
  if (s === 'esri-sat') return ESRI_MIRRORS.map((h) => esriUrl(h, 'World_Imagery', z, x, y));
  return [tileUrlFor(s, z, x, y)];
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

let osmConfig: OSMConfig = {
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
 * Получение URL тайла для выбранного рабочего провайдера (все — HTTPS, без ключей).
 * tileServer принимает и legacy-значения ('osm', 'carto') — они нормализуются
 * через normalizeTileServer в рабочие серверы из audit/index.fixed.html.
 * Порядок аргументов в URL соответствует каждому провайдеру (у Esri — z/y/x).
 */
export function getOSMTileUrl(
  zoom: number,
  x: number,
  y: number,
  tileServer: TileServerId | 'osm' | 'carto' = DEFAULT_TILE_SERVER,
  _style: TileStyle = 'scheme'
): string {
  const server = normalizeTileServer(tileServer);
  // Нативный максимум берётся из реестра провайдеров — выше не поднимаемся
  // (нет данных, только растяжение). Общий потолок сетки — z19.
  const nativeMax = TILE_PROVIDERS[server].maxNativeZoom;
  const z = Math.min(Math.max(Math.round(zoom), 0), 19);
  const zc = Math.min(z, nativeMax);
  return tileUrlFor(server, zc, x, y);
}

/**
 * Тайл с деградацией до maxNativeZoom: выше родного разрешения тайлы НЕ растягиваются —
 * берётся ближайший доступный уровень и рисуется в физическом разрешении.
 */
export async function loadTileImage(url: string, timeoutMs = 8000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { img.src = ''; noteTileError(url); resolve(null); }, timeoutMs);
    img.onload = () => { clearTimeout(timer); noteTileSuccess(); resolve(img); };
    img.onerror = () => { clearTimeout(timer); noteTileError(url); resolve(null); };
    img.src = url;
  });
}

/* ===== C. Учёт ошибок тайлов (аналог tileerror-наблюдателя из аудита) =====
   Каждая неудачная загрузка/таймаут увеличивает счётчик, каждая успешная —
   обнуляет его. При ≥3 ошибках подряд UI (MapCanvas) показывает понятное
   предупреждение «Слой недоступен, попробуйте другой стиль» и индикатор
   состояния слоя; alert() не используется. */
let tileErrorCount = 0;
const tileErrorListeners = new Set<(n: number) => void>();

export function getTileErrorCount(): number { return tileErrorCount; }

export function onTileError(cb: (n: number) => void): () => void {
  tileErrorListeners.add(cb);
  return () => { tileErrorListeners.delete(cb); };
}

function noteTileError(url: string): void {
  tileErrorCount++;
  tileErrorListeners.forEach((cb) => { try { cb(tileErrorCount); } catch { /* слушатель не должен ломать загрузку */ } });
  // Единичные ошибки внешних серверов — штатная ситуация: только console.warn,
  // без console.error (не засоряем консоль и не пугаем пользователя).
  if (tileErrorCount <= 5) console.warn('Не удалось загрузить тайл:', url);
}

function noteTileSuccess(): void {
  if (tileErrorCount !== 0) {
    tileErrorCount = 0; // авто-возврат в состояние «ок» после первой удачи
    tileErrorListeners.forEach((cb) => { try { cb(0); } catch { /* noop */ } });
  }
}

/**
 * Тайл с перебором зеркал: для Esri — server/services.arcgisonline.com
 * (основной хост иногда отдаёт 5xx под нагрузкой). Для URL других провайдеров —
 * обычная загрузка. Зеркала tile.openstreetmap.org УДАЛЕНЫ (403 по Referer).
 */
export async function loadTileWithMirrors(url: string, timeoutMs = 8000): Promise<HTMLImageElement | null> {
  const m = url.match(/^https:\/\/(server|services)\.arcgisonline\.com\/(.+)$/);
  if (!m) return loadTileImage(url, timeoutMs);
  for (const host of ESRI_MIRRORS) {
    const img = await loadTileImage(`${host}/${m[2]}`, timeoutMs);
    if (img) return img;
  }
  return null;
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
  tileServer: TileServerId | 'osm' | 'carto' = DEFAULT_TILE_SERVER
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
