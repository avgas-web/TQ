// Утилиты для работы с Google Maps API
import type { MapBounds } from "../types";

export interface GoogleMapsConfig {
  apiKey: string;
  loaded: boolean;
}

let googleMapsConfig: GoogleMapsConfig = {
  apiKey: '',
  loaded: false,
};

/**
 * Загрузка Google Maps API
 */
export function loadGoogleMapsApi(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // СМЕНА КЛЮЧА: если API уже загружен с ДРУГИМ ключом, старый скрипт
    // (window.google.maps) привязан к прежнему ключу — повторная загрузка
    // молча использовала бы его. Сбрасываем флаг и помечаем необходимость
    // перезагрузки; без этого смена ключа в настройках ничего бы не меняла.
    if (googleMapsConfig.loaded && googleMapsConfig.apiKey !== apiKey) {
      googleMapsConfig.loaded = false;
    }
    if (googleMapsConfig.loaded) {
      resolve();
      return;
    }

    if (!apiKey) {
      reject(new Error('API ключ не указан'));
      return;
    }

    googleMapsConfig.apiKey = apiKey;

    // Проверяем, не загружен ли уже скрипт С ЭТИМ ЖЕ ключом.
    // Раньше проверка была по подстрке домена — скрипт со СТАРЫМ ключом
    // считался «уже загруженным», и новый ключ никогда не применялся.
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src*="maps.googleapis.com/maps/api/js"]`);
    if (existing) {
      if (existing.src.includes(`key=${apiKey}`) && window.google && window.google.maps) {
        googleMapsConfig.loaded = true;
        resolve();
        return;
      }
      // другой ключ или недогруженный/ошибочный скрипт — удаляем и грузим заново,
      // иначе ветка ниже зависла бы навсегда (REJECTED-PROMISE RETRY).
      existing.remove();
      delete (window as any).google;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.defer = true;

    script.onload = () => {
      if (window.google && window.google.maps) {
        googleMapsConfig.loaded = true;
        resolve();
      } else {
        // убираем следы неудачной загрузки — повторный вызов получит шанс
        // загрузиться заново, а не упасть на «вечном» промежуточном состоянии
        script.remove();
        reject(new Error('Google Maps API не загружен (ключ отклонён или ответ повреждён)'));
      }
    };

    script.onerror = () => {
      script.remove();
      reject(new Error('Ошибка загрузки Google Maps API'));
    };

    document.head.appendChild(script);
  });
}

/**
 * Геокодирование адреса в координаты
 */
export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  if (!googleMapsConfig.loaded) {
    throw new Error('Google Maps API не загружен');
  }

  return new Promise((resolve) => {
    const geocoder = new window.google.maps.Geocoder();

    geocoder.geocode({ address }, (results, status) => {
      if (status === 'OK' && results && results.length > 0) {
        const location = results[0].geometry.location;
        resolve({
          lat: location.lat(),
          lng: location.lng(),
        });
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Обратное геокодирование (координаты в адрес)
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  if (!googleMapsConfig.loaded) {
    throw new Error('Google Maps API не загружен');
  }

  return new Promise((resolve) => {
    const geocoder = new window.google.maps.Geocoder();
    const latlng = { lat, lng };

    geocoder.geocode({ location: latlng }, (results, status) => {
      if (status === 'OK' && results && results.length > 0) {
        resolve(results[0].formatted_address);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Получение URL статической карты Google
 */
export function getStaticMapUrl(
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number,
  apiKey: string,
  mapType: 'roadmap' | 'satellite' | 'hybrid' | 'terrain' = 'satellite'
): string {
  const params = new URLSearchParams({
    center: `${center.lat},${center.lng}`,
    zoom: zoom.toString(),
    size: `${width}x${height}`,
    maptype: mapType,
    key: apiKey,
  });

  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

/**
 * Загрузка статической карты как DataURL
 */
export async function loadStaticMap(
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number,
  apiKey: string,
  mapType: 'roadmap' | 'satellite' | 'hybrid' | 'terrain' = 'satellite'
): Promise<{ dataUrl: string; bounds: MapBounds }> {
  const url = getStaticMapUrl(center, zoom, width, height, apiKey, mapType);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Не удалось создать canvas'));
        return;
      }

      ctx.drawImage(img, 0, 0);

      try {
        const dataUrl = canvas.toDataURL('image/png');
        const bounds = calculateBoundsFromCenter(center, zoom, width, height);
        resolve({ dataUrl, bounds });
      } catch {
        reject(new Error('Ошибка конвертации изображения'));
      }
    };

    img.onerror = () => {
      reject(new Error('Ошибка загрузки карты'));
    };

    img.src = url;
  });
}

// --- Web Mercator (EPSG:3857) — точная проекция для тайловых карт ---


const DEG2RAD = Math.PI / 180;

/** Широта -> нормализованная координата Mercator y (0..1, сверху вниз) */
export function latToMercatorY(lat: number): number {
  const clamped = Math.max(-89.9, Math.min(89.9, lat));
  const sinLat = Math.sin(clamped * DEG2RAD);
  return 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
}

/** Нормализованная координата Mercator y (0..1) -> широта */
export function mercatorYToLat(y: number): number {
  const n = Math.PI * (1 - 2 * y);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/**
 * Вычисление границ карты из центра и зума (Web Mercator)
 */
export function calculateBoundsFromCenter(
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number
): MapBounds {
  const worldPx = 256 * Math.pow(2, zoom); // размер мира в пикселях на данном зуме

  const centerY = latToMercatorY(center.lat);
  const northY = centerY - (height / 2) / worldPx;
  const southY = centerY + (height / 2) / worldPx;

  const lngPerPx = 360 / worldPx;
  const halfWidthLng = (width / 2) * lngPerPx;

  return {
    north: mercatorYToLat(northY),
    south: mercatorYToLat(southY),
    east: center.lng + halfWidthLng,
    west: center.lng - halfWidthLng,
  };
}

/**
 * Конвертация пиксельных координат изображения в географические
 * (корректная обратная Mercator-проекция по широте)
 */
export function pixelToGeoFromBounds(
  pixel: { x: number; y: number },
  bounds: MapBounds,
  mapWidth: number,
  mapHeight: number
): { lat: number; lng: number } {
  if (!mapWidth || !mapHeight) return { lat: 0, lng: 0 };

  const topY = latToMercatorY(bounds.north);
  const bottomY = latToMercatorY(bounds.south);
  const fx = Math.max(0, Math.min(1, pixel.x / mapWidth));
  const fy = Math.max(0, Math.min(1, pixel.y / mapHeight));

  const lat = mercatorYToLat(topY + (bottomY - topY) * fy);
  const lng = bounds.west + (bounds.east - bounds.west) * fx;

  return { lat, lng };
}

/**
 * Конвертация географических координат в пиксельные координаты изображения
 */
export function geoToPixelFromBounds(
  geo: { lat: number; lng: number },
  bounds: MapBounds,
  mapWidth: number,
  mapHeight: number
): { x: number; y: number } {
  const topY = latToMercatorY(bounds.north);
  const bottomY = latToMercatorY(bounds.south);

  const fy = (latToMercatorY(geo.lat) - topY) / (bottomY - topY);
  const fx = (geo.lng - bounds.west) / (bounds.east - bounds.west);

  return { x: fx * mapWidth, y: fy * mapHeight };
}

/**
 * Проверка статуса загрузки Google Maps API
 */
export function isGoogleMapsLoaded(): boolean {
  return googleMapsConfig.loaded;
}

/**
 * Получение текущего API ключа
 */
export function getGoogleMapsApiKey(): string {
  return googleMapsConfig.apiKey;
}
