// Утилиты для работы с хранилищем данных

const STORAGE_KEY = 'totalquadro-storage';
const MAP_DB_NAME = 'totalquadro-maps';
const MAP_STORE_NAME = 'maps';

/**
 * Проверка доступного места в localStorage
 */
export function checkLocalStorageQuota(): { used: number; available: number; percentage: number } {
  let used = 0;
  
  for (let key in localStorage) {
    if (localStorage.hasOwnProperty(key)) {
      used += localStorage[key].length + key.length;
    }
  }
  
  // Примерный лимит localStorage (5 МБ)
  const limit = 5 * 1024 * 1024;
  const available = Math.max(0, limit - used);
  const percentage = (used / limit) * 100;
  
  return { used, available, percentage };
}

/**
 * Очистка localStorage от старых данных
 */
export function cleanupLocalStorage(): void {
  try {
    const quota = checkLocalStorageQuota();
    
    if (quota.percentage > 80) {
      console.warn('localStorage заполнен на', quota.percentage.toFixed(1), '%');
      
      // Очищаем все кроме основных настроек
      const keysToKeep = [STORAGE_KEY];
      const keysToRemove = Object.keys(localStorage).filter(key => !keysToKeep.includes(key));
      
      keysToRemove.forEach(key => {
        localStorage.removeItem(key);
      });
      
      console.log('Очищено', keysToRemove.length, 'ключей из localStorage');
    }
  } catch (error) {
    console.error('Ошибка очистки localStorage:', error);
  }
}

/**
 * Пользовательское уведомление об ошибке сохранения (UX-слой).
 * console.error сам по себе невидим пользователю — при переполнении хранилища
 * данные терялись молча. Dispatch собственного события; компоненты могут
 * подписаться на него для показа тоста. detail содержит только текст (строку).
 */
export function notifyStorageError(message: string): void {
  try {
    window.dispatchEvent(new CustomEvent('tq:storage-error', { detail: message }));
  } catch {
    /* окружение без DOM — тихо пропускаем */
  }
}

/**
 * Безопасное сохранение в localStorage с обработкой ошибок
 */
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      console.error('localStorage quota exceeded for key:', key);
      
      // Пытаемся очистить место
      cleanupLocalStorage();
      
      // Пробуем снова
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (retryError) {
        console.error('Не удалось сохранить даже после очистки:', retryError);
        notifyStorageError('Хранилище браузера переполнено — последние изменения НЕ сохранены. Очистите старые карты или экспортируйте проект в файл.');
        return false;
      }
    }
    
    console.error('Ошибка сохранения в localStorage:', error);
    notifyStorageError('Не удалось сохранить данные в локальное хранилище браузера.');
    return false;
  }
}

/**
 * Инициализация IndexedDB для хранения карт
 */
export function initMapDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MAP_DB_NAME, 1);
    
    request.onerror = () => {
      reject(new Error('Не удалось открыть IndexedDB'));
    };
    
    request.onsuccess = () => {
      resolve(request.result);
    };
    
    request.onupgradeneeded = (event) => {
      const db = request.result;
      
      if (!db.objectStoreNames.contains(MAP_STORE_NAME)) {
        db.createObjectStore(MAP_STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

/**
 * Сохранение карты в IndexedDB
 */
export async function saveMapToIndexedDB(mapId: string, dataUrl: string): Promise<boolean> {
  try {
    const db = await initMapDatabase();
    
    return new Promise((resolve) => {
      const transaction = db.transaction([MAP_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(MAP_STORE_NAME);
      
      const request = store.put({
        id: mapId,
        dataUrl: dataUrl,
        timestamp: Date.now(),
      });
      
      request.onsuccess = () => {
        resolve(true);
      };
      
      request.onerror = () => {
        console.error('Ошибка сохранения карты в IndexedDB');
        resolve(false);
      };
    });
  } catch (error) {
    console.error('Ошибка сохранения карты:', error);
    return false;
  }
}

/**
 * Загрузка карты из IndexedDB
 */
export async function loadMapFromIndexedDB(mapId: string): Promise<string | null> {
  try {
    const db = await initMapDatabase();
    
    return new Promise((resolve) => {
      const transaction = db.transaction([MAP_STORE_NAME], 'readonly');
      const store = transaction.objectStore(MAP_STORE_NAME);
      
      const request = store.get(mapId);
      
      request.onsuccess = () => {
        if (request.result) {
          resolve(request.result.dataUrl);
        } else {
          resolve(null);
        }
      };
      
      request.onerror = () => {
        console.error('Ошибка загрузки карты из IndexedDB');
        resolve(null);
      };
    });
  } catch (error) {
    console.error('Ошибка загрузки карты:', error);
    return null;
  }
}

/**
 * Удаление карты из IndexedDB
 */
export async function deleteMapFromIndexedDB(mapId: string): Promise<boolean> {
  try {
    const db = await initMapDatabase();
    
    return new Promise((resolve) => {
      const transaction = db.transaction([MAP_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(MAP_STORE_NAME);
      
      const request = store.delete(mapId);
      
      request.onsuccess = () => {
        resolve(true);
      };
      
      request.onerror = () => {
        console.error('Ошибка удаления карты из IndexedDB');
        resolve(false);
      };
    });
  } catch (error) {
    console.error('Ошибка удаления карты:', error);
    return false;
  }
}

/**
 * Очистка всех карт из IndexedDB
 */
export async function clearAllMapsFromIndexedDB(): Promise<boolean> {
  try {
    const db = await initMapDatabase();
    
    return new Promise((resolve) => {
      const transaction = db.transaction([MAP_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(MAP_STORE_NAME);
      
      const request = store.clear();
      
      request.onsuccess = () => {
        resolve(true);
      };
      
      request.onerror = () => {
        console.error('Ошибка очистки IndexedDB');
        resolve(false);
      };
    });
  } catch (error) {
    console.error('Ошибка очистки IndexedDB:', error);
    return false;
  }
}

/**
 * Получение размера данных в IndexedDB
 */
export async function getIndexedDBSize(): Promise<number> {
  try {
    const db = await initMapDatabase();
    
    return new Promise((resolve) => {
      const transaction = db.transaction([MAP_STORE_NAME], 'readonly');
      const store = transaction.objectStore(MAP_STORE_NAME);
      
      const request = store.getAll();
      
      request.onsuccess = () => {
        const maps = request.result || [];
        const totalSize = maps.reduce((sum, map) => {
          return sum + (map.dataUrl?.length || 0);
        }, 0);
        resolve(totalSize);
      };
      
      request.onerror = () => {
        resolve(0);
      };
    });
  } catch (error) {
    return 0;
  }
}

/**
 * Форматирование размера файла
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Б';
  
  const k = 1024;
  const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
