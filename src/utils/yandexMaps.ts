// Утилиты для работы с Яндекс.Картами API

export interface YandexMapsConfig {
  apiKey: string;
  loaded: boolean;
}

let yandexMapsConfig: YandexMapsConfig = {
  apiKey: '',
  loaded: false,
};

/**
 * Загрузка Yandex Maps API
 */
export function loadYandexMapsApi(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (yandexMapsConfig.loaded) {
      resolve();
      return;
    }

    if (!apiKey) {
      reject(new Error('API ключ не указан'));
      return;
    }

    yandexMapsConfig.apiKey = apiKey;

    // Проверяем, не загружен ли уже скрипт
    if (document.querySelector(`script[src*="api-maps.yandex.ru"]`)) {
      if ((window as any).ymaps && (window as any).ymaps.ready) {
        yandexMapsConfig.loaded = true;
        resolve();
        return;
      }
    }

    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${apiKey}&lang=ru_RU`;
    script.async = true;
    script.defer = true;

    script.onload = () => {
      if ((window as any).ymaps && (window as any).ymaps.ready) {
        (window as any).ymaps.ready(() => {
          yandexMapsConfig.loaded = true;
          resolve();
        });
      } else {
        reject(new Error('Yandex Maps API не загружен'));
      }
    };

    script.onerror = () => {
      reject(new Error('Ошибка загрузки Yandex Maps API'));
    };

    document.head.appendChild(script);
  });
}

/**
 * Геокодирование адреса в координаты (Яндекс)
 */
export async function yandexGeocode(address: string): Promise<{ lat: number; lng: number } | null> {
  if (!yandexMapsConfig.loaded) {
    throw new Error('Yandex Maps API не загружен');
  }

  return new Promise((resolve, reject) => {
    const geocoder = new (window as any).ymaps.Geocoder();
    
    geocoder.geocode(address)
      .then((result: any) => {
        if (result.geoObjects.getLength() > 0) {
          const coords = result.geoObjects.get(0).geometry.getCoordinates();
          resolve({
            lat: coords[0],
            lng: coords[1],
          });
        } else {
          resolve(null);
        }
      })
      .catch((error: any) => {
        resolve(null);
      });
  });
}

/**
 * Обратное геокодирование (координаты в адрес) - Яндекс
 */
export async function yandexReverseGeocode(lat: number, lng: number): Promise<string | null> {
  if (!yandexMapsConfig.loaded) {
    throw new Error('Yandex Maps API не загружен');
  }

  return new Promise((resolve, reject) => {
    const geocoder = new (window as any).ymaps.Geocoder();
    
    geocoder.geocode([lat, lng])
      .then((result: any) => {
        if (result.geoObjects.getLength() > 0) {
          const address = result.geoObjects.get(0).getAddressLine();
          resolve(address);
        } else {
          resolve(null);
        }
      })
      .catch((error: any) => {
        resolve(null);
      });
  });
}

/**
 * Получение статической карты Яндекс
 */
export function getYandexStaticMapUrl(
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number,
  apiKey: string,
  mapType: 'map' | 'satellite' | 'hybrid' = 'satellite'
): string {
  const params = new URLSearchParams({
    ll: `${center.lng},${center.lat}`,
    z: zoom.toString(),
    size: `${width},${height}`,
    l: mapType,
    lang: 'ru_RU',
  });

  return `https://static-maps.yandex.ru/1.x/?${params.toString()}`;
}

/**
 * Загрузка статической карты Яндекс как DataURL
 */
export async function loadYandexStaticMap(
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number,
  apiKey: string,
  mapType: 'map' | 'satellite' | 'hybrid' = 'satellite'
): Promise<{ dataUrl: string; bounds: { north: number; south: number; east: number; west: number } }> {
  const url = getYandexStaticMapUrl(center, zoom, width, height, apiKey, mapType);

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
        
        // Вычисляем границы карты
        const bounds = calculateYandexBoundsFromCenter(center, zoom, width, height);
        
        resolve({ dataUrl, bounds });
      } catch (e) {
        reject(new Error('Ошибка конвертации изображения'));
      }
    };
    
    img.onerror = () => {
      reject(new Error('Ошибка загрузки карты'));
    };
    
    img.src = url;
  });
}

/**
 * Вычисление границ карты из центра и зума (Яндекс)
 */
function calculateYandexBoundsFromCenter(
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number
): { north: number; south: number; east: number; west: number } {
  // Приблизительное вычисление границ для Яндекс.Карт
  const latPerPx = 360 / Math.pow(2, zoom + 8);
  const lngPerPx = 360 / Math.pow(2, zoom + 8);
  
  const halfHeightLat = (height / 2) * latPerPx;
  const halfWidthLng = (width / 2) * lngPerPx;
  
  return {
    north: center.lat + halfHeightLat,
    south: center.lat - halfHeightLat,
    east: center.lng + halfWidthLng,
    west: center.lng - halfWidthLng,
  };
}

/**
 * Проверка статуса загрузки Yandex Maps API
 */
export function isYandexMapsLoaded(): boolean {
  return yandexMapsConfig.loaded;
}

/**
 * Получение текущего API ключа
 */
export function getYandexMapsApiKey(): string {
  return yandexMapsConfig.apiKey;
}
