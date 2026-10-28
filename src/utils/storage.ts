// Утилиты для работы с хранилищем данных

/**
 * Ключ persist-стора. ЭТАП 3 (боевая терминология) переименовал доменные поля,
 * но сам ключ остаётся стабильным: менять его нельзя — это разрыв совместимости
 * с уже сохранёнными проектами. Переименованные поля читаются из старых записей
 * через migratePersistedState (старые имена читаются, новые пишутся).
 */
const STORAGE_KEY = 'totalquadro-storage';

/**
 * Миграция ключей/полей хранилища под боевую терминологию.
 * oldKey -> newKey в теле сохранённого состояния (persist payload).
 * Читаем старое имя, пишем новое, старое удаляем после успешного переноса.
 */
export const LEGACY_STATE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  droneAssignments: 'combatAssetAssignments',
  droneCount: 'assetCount',
  droneGoals: 'strikeObjectives',
  droneStarts: 'combatAssetStarts',
  nfzList: 'adizList',
  routeDraft: 'tacticalProjection',
  draftRoute: 'tacticalProjection',
  waypoints: 'tacticalNodes',
  waypointParams: 'tacticalNodeParams',
  gameLoop: 'combatCycle',
});

/**
 * Миграция вложенных полей маршрутов (project.routes[]): старые имена параметров
 * узлов боевого курса читаются, новые пишутся, старые удаляются. Идемпотентно.
 */
const LEGACY_ROUTE_FIELD_KEYS: Readonly<Record<string, string>> = Object.freeze({
  waypointParams: 'tacticalNodeParams',
});

function migrateRouteShapes(state: Record<string, any>): void {
  const routes = state?.project?.routes;
  if (!Array.isArray(routes)) return;
  for (const r of routes) {
    if (!r || typeof r !== 'object') continue;
    for (const [legacyKey, newKey] of Object.entries(LEGACY_ROUTE_FIELD_KEYS)) {
      if (!(legacyKey in r)) continue;
      const legacyValue = r[legacyKey];
      const hasNew = newKey in r && r[newKey] !== undefined && r[newKey] !== null;
      const newIsEmpty = hasNew && typeof r[newKey] === 'object' && Object.keys(r[newKey]).length === 0;
      if (!hasNew || newIsEmpty) r[newKey] = legacyValue;
      delete r[legacyKey];
    }
  }
}

/**
 * Перенос легаси-полей в боевую терминологию. Идемпотентна: повторный вызов
 * ничего не меняет. Если новое поле уже присутствует и не пустое — старое
 * просто удаляется (новое приоритетнее: оно записано текущей версией стора).
 */
export function migratePersistedState<T extends Record<string, any>>(state: T | null | undefined): T {
  const out: Record<string, any> = { ...(state ?? {}) };
  for (const [legacyKey, newKey] of Object.entries(LEGACY_STATE_KEYS)) {
    if (!(legacyKey in out)) continue;
    const legacyValue = out[legacyKey];
    const hasNew = newKey in out && out[newKey] !== undefined && out[newKey] !== null;
    const newIsEmpty = hasNew && Array.isArray(out[newKey]) && out[newKey].length === 0;
    if (!hasNew || newIsEmpty) {
      out[newKey] = legacyValue;
    }
    delete out[legacyKey];
  }
  migrateRouteShapes(out);
  return out as T;
}
const MAP_DB_NAME = 'totalquadro-maps';
const MAP_STORE_NAME = 'maps';
/** Версия БД: 2 — добавлен store «userlayers» (пользовательские тактические карты) */
const MAP_DB_VERSION = 2;
const USER_LAYER_STORE_NAME = 'userlayers';

/** Максимальный размер слоя, при котором он ещё допускается к загрузке (150 МБ).
 *  IndexedDB физически вмещает больше, но такие файлы почти всегда ошибочны. */
export const MAX_USER_LAYER_BYTES = 150 * 1024 * 1024;

/**
 * Проверка доступного места в localStorage
 */
export function checkLocalStorageQuota(): { used: number; available: number; percentage: number } {
  let used = 0;
  
  // Реальный Storage перечисляет ключи как свойства объекта, но не является их
  // владельцем (Object.getPrototypeOf(localStorage) === Storage.prototype),
  // поэтому hasOwnProperty в старом коде всегда давал false и объём считался как 0.
  // Корректный итератор: Object.keys + length/key(i).
  const ownKeys = Object.keys(localStorage);
  for (const key of ownKeys) {
    used += key.length + String(localStorage.getItem(key) ?? '').length;
  }
  const count = Number(localStorage.length) || 0;
  for (let i = 0; i < count; i++) {
    const key = localStorage.key(i);
    if (key && !ownKeys.includes(key)) {
      used += key.length + String(localStorage.getItem(key) ?? '').length;
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
 * Сохранение «сверх» лимита localStorage.
 *
 * Жёсткий браузерный квота-лимит (~5 МБ на источник) из кода не поднимается —
 * его обходят объёмом данных: тяжёлое значение выносится в IndexedDB (лимита по
 * объёму нет), а в localStorage остаётся маленький маркер-ссылка.
 *
 * Порядок при переполнении:
 *   1. освободить место (одноразовые служебные записи + легаси-мусор), повторная запись;
 *   2. если не помогло — spill в IndexedDB под `{ "__tqSpill": id }`;
 *   3. при недоступном IndexedDB — честно сообщить пользователю и вернуть false.
 * Чтение/удаление таких значений — через `safeGetItem` / `safeRemoveItem`.
 */
const SPILL_PREFIX = 'spill:';
const SPILL_MARKER = '{"__tqSpill":';

/** Освободить место в localStorage, удаляя одноразовые и легаси-записи */
function freeLocalStorageSpace(keepKeys: string[]): number {
  let removed = 0;
  try {
    const keys = Object.keys(localStorage).filter((k) => !keepKeys.includes(k));
    // Одноразовые ключи вида `mission-launch-<ts>` чистим первыми: они самые
    // большие по объёму и не участвуют в восстановлении состояния.
    const tsOf = (k: string) => Number(/-(\d{10,})$/.exec(k)?.[1] ?? Infinity);
    const ephemeral = keys.filter((k) => /-(\d{10,})$/.test(k)).sort((a, b) => tsOf(a) - tsOf(b));
    const rest = keys.filter((k) => !/-(\d{10,})$/.test(k));
    for (const key of [...ephemeral, ...rest]) {
      try { localStorage.removeItem(key); removed += 1; } catch { /* пропускаем */ }
      if (removed >= 64) break;
    }
  } catch { /* доступ к хранилищу запрещён — освобождать нечего */ }
  return removed;
}

/** Прочитать значение из localStorage, развернув spill-запись из IndexedDB */
export async function safeGetItem(key: string): Promise<string | null> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null || !raw.startsWith(SPILL_MARKER)) return raw;
  try {
    const marker = JSON.parse(raw) as { __tqSpill?: string };
    if (!marker.__tqSpill) return null;
    const record = await loadUserLayerFromIndexedDB(marker.__tqSpill);
    if (!record) return null;
    if (typeof record.sourceText === 'string') return record.sourceText;
    if (typeof record.imageDataUrl === 'string') return record.imageDataUrl;
    if (record.sourceBlob) return await new Blob([record.sourceBlob]).text();
    return null;
  } catch {
    return null;
  }
}

/** Удалить значение вместе с возможным spill-файлом в IndexedDB */
export async function safeRemoveItem(key: string): Promise<void> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { /* недоступно */ }
  if (raw && raw.startsWith(SPILL_MARKER)) {
    try {
      const marker = JSON.parse(raw) as { __tqSpill?: string };
      if (marker.__tqSpill) await deleteUserLayerFromIndexedDB(marker.__tqSpill);
    } catch { /* уже удалено */ }
  }
  try { localStorage.removeItem(key); } catch { /* недоступно */ }
}

/**
 * Безопасное сохранение в localStorage с обработкой ошибок и spill-переполнения
 */
export async function safeSetItem(key: string, value: string): Promise<boolean> {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    const quotaHit = error instanceof DOMException
      && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    if (quotaHit) {
      console.warn('localStorage quota exceeded for key:', key);

      // Пытаемся очистить место и пробуем снова
      freeLocalStorageSpace([STORAGE_KEY, key]);
      try {
        localStorage.setItem(key, value);
        return true;
      } catch {
        // Место всё равно недостаточно: уносим объём в IndexedDB (без квоты),
        // в localStorage остаётся только маленький маркер-ссылка.
        const spillId = `${SPILL_PREFIX}${key}`;
        let spilled = false;
        try {
          spilled = await saveUserLayerToIndexedDB({
            id: spillId,
            sourceText: value,
            bytes: value.length,
            timestamp: Date.now(),
          });
        } catch {
          spilled = false;
        }
        // saveUserLayerToIndexedDB перехватывает собственные ошибки и возвращает
        // false — без проверки факта записи «неудавшийся» spill считался успехом.
        if (!spilled || !(await loadUserLayerFromIndexedDB(spillId))) {
          try { await deleteUserLayerFromIndexedDB(spillId); } catch { /* записи нет */ }
          notifyStorageError('Хранилище браузера переполнено — последние изменения НЕ сохранены. Очистите старые карты или экспортируйте проект в файл.');
          return false;
        }
        try {
          localStorage.setItem(key, JSON.stringify({ __tqSpill: spillId }));
          return true;
        } catch (markerError) {
          console.error('Не удалось записать spill-маркер в localStorage:', markerError);
          try { await deleteUserLayerFromIndexedDB(spillId); } catch { /* записи нет */ }
          notifyStorageError('Хранилище браузера переполнено — последние изменения НЕ сохранены. Очистите старые карты или экспортируйте проект в файл.');
          return false;
        }
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
/**
 * Ошибка отказа в доступе к приватному хранилищу (Private Browsing / Safari
 * без разрешения / полностью заполненный диск). В таких окружениях вызов
 * indexedDB.open бросает **синхронную** SecurityError либо приводит к
 * immediate `onerror`; раньше она «глоталась» и карта молча не сохранялась.
 */
export class StorageUnavailableError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'StorageUnavailableError';
    this.cause = cause;
  }
}

/** Доступно ли IndexedDB в текущем окружении (без бросания исключений) */
export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    // Safari private mode может бросать на самом обращении к global-свойству
    return false;
  }
}

/** Открыть БД с явной обработкой отказа доступа (SecurityError -> StorageUnavailableError) */
export function initMapDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbAvailable()) {
      reject(new StorageUnavailableError(
        'Приватное хранилище недоступно: браузер блокирует IndexedDB (режим инкогнито или ограничение сайта)'
      ));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(MAP_DB_NAME, MAP_DB_VERSION);
    } catch (error) {
      // синхронный SecurityError/TypeError (приватный режим Safari, file:// в Firefox)
      reject(new StorageUnavailableError(
        'Приватное хранилище недоступно: браузер отказал в доступе к IndexedDB', error));
      return;
    }

    request.onerror = () => {
      const err = request.error;
      if (err && err.name === 'SecurityError') {
        reject(new StorageUnavailableError(
          'Приватное хранилище недоступно: браузер отказал в доступе к IndexedDB', err));
        return;
      }
      reject(new Error(`Не удалось открыть IndexedDB${err ? ` (${err.name})` : ''}`));
    };

    // onblocked: другая вкладка держит старую версию БД —
    // событие отличается от onerror (отказ хранилища). Раньше не
    // обрабатывалось, и Promise висел вечно; теперь — явная ошибка.
    request.onblocked = () => {
      reject(new Error('IndexedDB заблокирована другой открытой вкладкой — закройте её и повторите'));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = request.result;

      if (!db.objectStoreNames.contains(MAP_STORE_NAME)) {
        db.createObjectStore(MAP_STORE_NAME, { keyPath: 'id' });
      }
      // v2: пользовательские тактические карты (данные отделены от снимков подложки)
      if (!db.objectStoreNames.contains(USER_LAYER_STORE_NAME)) {
        db.createObjectStore(USER_LAYER_STORE_NAME, { keyPath: 'id' });
      }
      void event;
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

// ─── Пользовательские тактические карты (IndexedDB) ──────────────────────────
// Данные слоёв НЕ попадают в localStorage: там остаётся только минимальная
// запись (метаданные + флаги), сами пиксели/тайлы — в отдельном store.

/** Запись store «userlayers»: id слоя + его данные */
export interface UserLayerBlobRecord {
  id: string;
  /** PNG/JPEG data URL растра (image/geotiff) */
  imageDataUrl?: string;
  /** GeoJSON/KML/KMZ текст (для повторного экспорта и отладки) */
  sourceText?: string;
  /** MBTiles: бинарник SQLite (тайлы читаются лениво через sql.js) */
  sourceBlob?: ArrayBuffer;
  /** Тайлы MBTiles, извлечённые при загрузке: "z/x/y" -> data URL */
  tiles?: Record<string, string>;
  bytes: number;
  timestamp: number;
}

/** Ограничения на объём хранилища пользовательских карт */
export const USER_LAYER_LIMITS = {
  maxBytesPerLayer: MAX_USER_LAYER_BYTES,
  maxLayers: 20,
  /** Предупреждение при суммарном объёме слоёв, байт */
  warnTotalBytes: 100 * 1024 * 1024,
};

/** Проверка допустимости файла слоя по размеру; возвращает текст ошибки или null */
export function validateUserLayerSize(bytes: number, fileName = ''): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return `Файл «${fileName}» пуст или повреждён`;
  }
  if (bytes > USER_LAYER_LIMITS.maxBytesPerLayer) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const lim = (USER_LAYER_LIMITS.maxBytesPerLayer / (1024 * 1024)).toFixed(0);
    return `Файл «${fileName}» слишком большой (${mb} МБ). Предел ${lim} МБ на слой — уменьшите область или разрешение карты`;
  }
  return null;
}

async function withStore<T>(
  storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await initMapDatabase();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn2: () => void) => { if (!settled) { settled = true; fn2(); } };
    const transaction = db.transaction([storeName], mode);
    const store = transaction.objectStore(storeName);
    const request = fn(store);
    request.onsuccess = () => finish(() => resolve(request.result));
    request.onerror = () => finish(() => reject(request.error ?? new Error('Ошибка IndexedDB')));
    // abort/error транзакции (например QuotaExceededError при put) тоже должен
    // завершать промис — иначе загрузка «висит» без ответа
    transaction.onabort = () => finish(() => reject(transaction.error ?? new Error('Транзакция IndexedDB прервана')));
    transaction.onerror = () => finish(() => reject(transaction.error ?? new Error('Ошибка транзакции IndexedDB')));
  });
}

/** Сохранение данных пользовательского слоя (растр/источник/тайлы) */
export async function saveUserLayerToIndexedDB(record: UserLayerBlobRecord): Promise<boolean> {
  try {
    await withStore(USER_LAYER_STORE_NAME, 'readwrite', (store) =>
      store.put({ ...record, timestamp: Date.now() }) as IDBRequest<IDBValidKey>);
    return true;
  } catch (error) {
    console.error('Ошибка сохранения тактической карты:', error);
    if (error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22)) {
      notifyStorageError('Хранилище браузера переполнено — тактическая карта не сохранена. Удалите старые слои.');
    } else if (error instanceof StorageUnavailableError) {
      notifyStorageError(error.message);
    }
    return false;
  }
}

/** Чтение записи слоя (или null, если данных нет) */
export async function loadUserLayerFromIndexedDB(id: string): Promise<UserLayerBlobRecord | null> {
  try {
    const res = await withStore<UserLayerBlobRecord | undefined>(USER_LAYER_STORE_NAME, 'readonly', (store) =>
      store.get(id) as IDBRequest<UserLayerBlobRecord | undefined>);
    return res ?? null;
  } catch (error) {
    if (error instanceof StorageUnavailableError) notifyStorageError(error.message);
    console.error('Ошибка загрузки тактической карты:', error);
    return null;
  }
}

/** Удаление данных слоя */
export async function deleteUserLayerFromIndexedDB(id: string): Promise<boolean> {
  try {
    await withStore(USER_LAYER_STORE_NAME, 'readwrite', (store) => store.delete(id) as IDBRequest<undefined>);
    return true;
  } catch (error) {
    console.error('Ошибка удаления тактической карты:', error);
    return false;
  }
}

/** Все id сохранённых слоёв (для сверки с метаданными проекта / сборки мусора) */
export async function listUserLayerIds(): Promise<string[]> {
  try {
    const keys = await withStore<IDBValidKey[]>(USER_LAYER_STORE_NAME, 'readonly', (store) =>
      store.getAllKeys() as IDBRequest<IDBValidKey[]>);
    return keys.map(String);
  } catch {
    return [];
  }
}

/** Суммарный объём данных пользовательских слоёв, байт */
export async function getUserLayersTotalBytes(): Promise<number> {
  try {
    const all = await withStore<UserLayerBlobRecord[]>(USER_LAYER_STORE_NAME, 'readonly', (store) =>
      store.getAll() as IDBRequest<UserLayerBlobRecord[]>);
    return (all || []).reduce((sum, r) => sum + (r.bytes || 0), 0);
  } catch {
    return 0;
  }
}
