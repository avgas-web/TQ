// Утилиты для работы с OpenStreetMap
import { calculateBoundsFromCenter } from './googleMaps';

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
 * Геокодирование адреса через Nominatim (OSM)
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
 * Обратное геокодирование через Nominatim (OSM)
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
  
  // Вычисляем границы
  const bounds = calculateOSMBoundsFromCenter(center, zoom, width, height);
  
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
  
  // Вычисляем центральный тайл
  const centerTile = latLngToTile(center.lat, center.lng, zoom);
  
  // Вычисляем сколько тайлов нужно загрузить
  const tilesX = Math.ceil(width / 256) + 1;
  const tilesY = Math.ceil(height / 256) + 1;
  
  const startTileX = centerTile.x - Math.floor(tilesX / 2);
  const startTileY = centerTile.y - Math.floor(tilesY / 2);
  
  // Загружаем и рисуем тайлы
  const tilePromises: Promise<void>[] = [];
  
  for (let dy = 0; dy < tilesY; dy++) {
    for (let dx = 0; dx < tilesX; dx++) {
      const tileX = startTileX + dx;
      const tileY = startTileY + dy;
      
      // Проверяем валидность тайла
      if (tileX < 0 || tileY < 0 || tileX >= Math.pow(2, zoom) || tileY >= Math.pow(2, zoom)) {
        continue;
      }
      
      const tileUrl = getOSMTileUrl(zoom, tileX, tileY, tileServer);
      
      const promise = new Promise<void>((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        img.onload = () => {
          const pixelX = dx * 256;
          const pixelY = dy * 256;
          ctx.drawImage(img, pixelX, pixelY, 256, 256);
          resolve();
        };
        
        img.onerror = () => {
          console.warn(`Не удалось загрузить тайл: ${tileUrl}`);
          // Рисуем placeholder для неудачного тайла
          const pixelX = dx * 256;
          const pixelY = dy * 256;
          ctx.fillStyle = '#cccccc';
          ctx.fillRect(pixelX, pixelY, 256, 256);
          ctx.strokeStyle = '#999999';
          ctx.lineWidth = 1;
          ctx.strokeRect(pixelX, pixelY, 256, 256);
          resolve(); // Продолжаем даже если тайл не загрузился
        };
        
        img.src = tileUrl;
      });
      
      tilePromises.push(promise);
    }
  }
  
  await Promise.all(tilePromises);
  
  console.log(`Загружено ${tilePromises.length} тайлов для сервера ${tileServer}`);
  
  // Смещаем изображение чтобы центр был в центре canvas
  const offsetX = (width - tilesX * 256) / 2;
  const offsetY = (height - tilesY * 256) / 2;
  
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
