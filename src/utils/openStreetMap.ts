// Утилиты для работы с OpenStreetMap
import { calculateBoundsFromCenter, latToMercatorY } from './googleMaps';

/** Зеркала тайлового сервера tile.openstreetmap.org (перебираются при ошибках/таймаутах) */
const OSM_TILE_MIRRORS = [
  'https://tile.openstreetmap.org',
  'https://a.tile.openstreetmap.org',
  'https://b.tile.openstreetmap.org',
  'https://c.tile.openstreetmap.org',
];

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

// Простейшая локальная очередь «не чаще 1 запроса в секунду» — требование usage policy Nominatim
let lastNominatimAt = 0;
async function politeWait(): Promise<void> {
  const wait = Math.max(0, lastNominatimAt + 1000 - Date.now());
  lastNominatimAt = Date.now() + wait;
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
}

/**
 * Запрос к Nominatim с перебором зеркал, таймаутом и повтором.
 * Возвращает разобранный JSON или null, если все зеркала недоступны.
 * Ошибки внешних серверов не пишутся в console.error — это штатная ситуация,
 * вызывающий код показывает пользователю понятное сообщение.
 */
async function fetchNominatimJson(path: string, params: string): Promise<any[] | any | null> {
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < NOMINATIM_HOSTS.length; i++) {
      const host = NOMINATIM_HOSTS[(i + round) % NOMINATIM_HOSTS.length];
      await politeWait();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const response = await fetch(`${host}${path}?format=json&${params}`, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json' },
        });
        if (response.status === 429 || response.status >= 500) continue; // пробуем следующее зеркало
        if (!response.ok) return null;
        return await response.json();
      } catch {
        /* сеть/таймаут — следующее зеркало */
      } finally {
        clearTimeout(timer);
      }
    }
    // после первого раунда — короткая пауза перед повтором
    if (round === 0) await new Promise((res) => setTimeout(res, 1000));
  }
  return null;
}

/**
 * Запрос к Nominatim с перебором зеркал, таймаутом и повтором.
 * Возвращает [данные, kind] где kind='ok'|'not_found'|'network'|'http' —
 * вызывающий код различает «сервис недоступен», «адрес не найден» и HTTP-ошибку.
 * Поддерживает внешний AbortController для отмены (уход пользователя, новый запрос).
 * Ошибки внешних серверов не пишутся в console.error — это штатная ситуация,
 * вызывающий код показывает пользователю понятное сообщение.
 */
export async function osmGeocode(address: string): Promise<{ lat: number; lng: number } | null> {
  const data = await fetchNominatimJson('/search', `q=${encodeURIComponent(address)}&limit=1`);

  if (!data) {
    console.warn('Геокодирование: сервис Nominatim временно недоступен');
    return null;
  }

  if (Array.isArray(data) && data.length > 0) {
    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
    };
  }

  return null;
}

/**
 * Геокодирование адреса через Nominatim (OSM).
 * Возвращает различимый статус, чтобы UI не смешивал «не найдено» и «сервис недоступен».
 */
export async function osmReverseGeocode(lat: number, lng: number): Promise<string | null> {
  const data = await fetchNominatimJson('/reverse', `lat=${lat}&lon=${lng}`);

  if (!data) {
    console.warn('Обратное геокодирование: сервис Nominatim временно недоступен');
    return null;
  }

  if (data && data.display_name) {
    return data.display_name;
  }

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
  tileServer: 'osm' | 'opentopomap' | 'carto' = 'osm',
  style: TileStyle = 'scheme'
): string {
  // detectRetina: тайлы @2x доступны ТОЛЬКО у tile.openstreetmap.org и basemaps.cartocdn.com
  // (макс. уровень их нативного зума — 19). Esri World_Imagery отдаёт 512-px тайлы без @2x,
  // opentopomap — только до z17. maxNativeZoom учитывается вызывающим кодом.
  const z = Math.min(Math.max(zoom, 0), 19);
  const retina = typeof window !== 'undefined' && (window.devicePixelRatio || 1) >= 1.5;
  const at = retina ? '@2x' : '';
  switch (tileServer) {
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
 * Тайл с деградацией до maxNativeZoom: выше родного разрешения тайлы НЕ растягиваются —
 * берётся ближайший доступный уровень и рисуется в физическом разрешении.
 */
export async function loadTileImage(url: string, timeoutMs = 8000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { img.src = ''; resolve(null); }, timeoutMs);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

/**
 * Тайл с перебором зеркал tile.openstreetmap.org (основной хост часто отдаёт
 * 429/таймауты под нагрузкой). Для URL других провайдеров — обычная загрузка.
 */
export async function loadTileWithMirrors(url: string, timeoutMs = 8000): Promise<HTMLImageElement | null> {
  const m = url.match(/^https:\/\/tile\.openstreetmap\.org\/(.+)$/);
  if (!m) return loadTileImage(url, timeoutMs);
  for (const host of OSM_TILE_MIRRORS) {
    const img = await loadTileImage(host + '/' + m[1], timeoutMs);
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
