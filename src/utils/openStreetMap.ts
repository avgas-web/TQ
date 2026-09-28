// Утилиты для работы с OpenStreetMap

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

/**
 * Геокодирование адреса через Nominatim (OSM)
 */
export async function osmGeocode(address: string): Promise<{ lat: number; lng: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'TotalQuadro-Coordinate-Marker/1.0',
      },
    });
    
    if (!response.ok) {
      throw new Error('Ошибка геокодирования');
    }
    
    const data = await response.json();
    
    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
      };
    }
    
    return null;
  } catch (error) {
    console.error('Ошибка геокодирования OSM:', error);
    return null;
  }
}

/**
 * Обратное геокодирование через Nominatim (OSM)
 */
export async function osmReverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'TotalQuadro-Coordinate-Marker/1.0',
      },
    });
    
    if (!response.ok) {
      throw new Error('Ошибка обратного геокодирования');
    }
    
    const data = await response.json();
    
    if (data && data.display_name) {
      return data.display_name;
    }
    
    return null;
  } catch (error) {
    console.error('Ошибка обратного геокодирования OSM:', error);
    return null;
  }
}

/**
 * Получение URL тайла OSM
 */
export function getOSMTileUrl(
  zoom: number,
  x: number,
  y: number,
  tileServer: 'osm' | 'opentopomap' | 'carto' = 'osm'
): string {
  switch (tileServer) {
    case 'opentopomap':
      return `https://tile.opentopomap.org/${zoom}/${x}/${y}.png`;
    case 'carto':
      return `https://cartodb-basemaps-a.global.ssl.fastly.net/light_all/${zoom}/${x}/${y}.png`;
    case 'osm':
    default:
      return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
  }
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
          resolve(); // Продолжаем даже если тайл не загрузился
        };
        
        img.src = tileUrl;
      });
      
      tilePromises.push(promise);
    }
  }
  
  await Promise.all(tilePromises);
  
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

/**
 * Вычисление границ карты из центра и зума (OSM)
 */
function calculateOSMBoundsFromCenter(
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number
): { north: number; south: number; east: number; west: number } {
  // Для OSM используем Mercator projection
  const tilesX = Math.ceil(width / 256);
  const tilesY = Math.ceil(height / 256);
  
  const centerTile = latLngToTile(center.lat, center.lng, zoom);
  
  const startTileX = centerTile.x - Math.floor(tilesX / 2);
  const startTileY = centerTile.y - Math.floor(tilesY / 2);
  const endTileX = startTileX + tilesX;
  const endTileY = startTileY + tilesY;
  
  const topLeft = tileToLatLng(startTileX, startTileY, zoom);
  const bottomRight = tileToLatLng(endTileX, endTileY, zoom);
  
  return {
    north: topLeft.lat,
    south: bottomRight.lat,
    east: bottomRight.lng,
    west: topLeft.lng,
  };
}

/**
 * Проверка статуса инициализации OSM
 */
export function isOSMLoaded(): boolean {
  return osmConfig.loaded;
}
