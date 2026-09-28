// Утилиты для работы с Google Maps API

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
    if (googleMapsConfig.loaded) {
      resolve();
      return;
    }

    if (!apiKey) {
      reject(new Error('API ключ не указан'));
      return;
    }

    googleMapsConfig.apiKey = apiKey;

    // Проверяем, не загружен ли уже скрипт
    if (document.querySelector(`script[src*="maps.googleapis.com"]`)) {
      if (window.google && window.google.maps) {
        googleMapsConfig.loaded = true;
        resolve();
        return;
      }
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
        reject(new Error('Google Maps API не загружен'));
      }
    };

    script.onerror = () => {
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

  return new Promise((resolve, reject) => {
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

  return new Promise((resolve, reject) => {
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
 * Получение статической карты как изображение
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
): Promise<{ dataUrl: string; bounds: { north: number; south: number; east: number; west: number } }> {
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
        
        // Вычисляем границы карты
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
 * Вычисление границ карты из центра и зума
 */
function calculateBoundsFromCenter(
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number
): { north: number; south: number; east: number; west: number } {
  // Приблизительное вычисление границ
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
 * Конвертация пиксельных координат в географические
 */
export function pixelToGeoFromBounds(
  pixel: { x: number; y: number },
  bounds: { north: number; south: number; east: number; west: number },
  mapWidth: number,
  mapHeight: number
): { lat: number; lng: number } {
  const latRange = bounds.north - bounds.south;
  const lngRange = bounds.east - bounds.west;
  
  const lat = bounds.north - (pixel.y / mapHeight) * latRange;
  const lng = bounds.west + (pixel.x / mapWidth) * lngRange;
  
  return { lat, lng };
}

/**
 * Конвертация географических координат в пиксельные
 */
export function geoToPixelFromBounds(
  geo: { lat: number; lng: number },
  bounds: { north: number; south: number; east: number; west: number },
  mapWidth: number,
  mapHeight: number
): { x: number; y: number } {
  const latRange = bounds.north - bounds.south;
  const lngRange = bounds.east - bounds.west;
  
  const x = ((geo.lng - bounds.west) / lngRange) * mapWidth;
  const y = ((bounds.north - geo.lat) / latRange) * mapHeight;
  
  return { x, y };
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
