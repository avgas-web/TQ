// Утилиты для работы с Яндекс.Картами API
import { calculateBoundsFromCenter } from './googleMaps';

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

    // СМЕНА КЛЮЧА: сброшенный флаг при другом ключе — иначе загруженный ранее
    // API продолжал работать со старым ключом бесконечно.
    if (yandexMapsConfig.loaded && yandexMapsConfig.apiKey !== apiKey) {
      yandexMapsConfig.loaded = false;
    }

    yandexMapsConfig.apiKey = apiKey;

    // Проверяем, не загружен ли уже скрипт С ЭТИМ ЖЕ ключом
    const existing = document.querySelector<HTMLScriptElement>(`script[src*="api-maps.yandex.ru"]`);
    if (existing) {
      if (existing.src.includes(`apikey=${apiKey}`) && (window as any).ymaps && (window as any).ymaps.ready) {
        yandexMapsConfig.loaded = true;
        resolve();
        return;
      }
      existing.remove();
      delete (window as any).ymaps;
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
        // REJECTED-PROMISE RETRY: при отказе убираем следы неудачной загрузки,
        // чтобы повторный вызов мог начать заново, а не мгновенно падать на
        // том же кэшированном rejection (раньше все ретраисы были невозможны).
        script.remove();
        reject(new Error('Yandex Maps API не загружен'));
      }
    };

    script.onerror = () => {
      // Скрипт не дошёл (сеть/блокатор) — удаляем его из DOM, иначе ветка
      // document.querySelector('script[src*=...]') ниже решит, что API уже
      // «в процессе загрузки», и все последующие попытки зависнут навсегда.
      script.remove();
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

  // Статический API Яндекс.Карт требует API-ключ (иначе возвращает 403)
  if (apiKey) {
    params.set('key', apiKey);
  }

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
        
        // Вычисляем границы карты (Web Mercator — та же проекция, что у Яндекс.Карт)
        const bounds = calculateBoundsFromCenter(center, zoom, width, height);
        
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
