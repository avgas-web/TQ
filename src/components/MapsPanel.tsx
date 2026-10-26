import React, { useState, useRef } from 'react';
import { useStore } from '../store/useStore';
import { loadGoogleMapsApi, geocodeAddress, loadStaticMap, isGoogleMapsLoaded } from '../utils/googleMaps';
import { loadYandexMapsApi, yandexGeocode, loadYandexStaticMap, isYandexMapsLoaded } from '../utils/yandexMaps';
import { osmGeocode } from '../utils/openStreetMap';
import { TILE_PROVIDERS, TILE_SERVER_ORDER, DEFAULT_TILE_SERVER, normalizeTileServer } from '../utils/openStreetMap';
import type { TileServerId } from '../utils/openStreetMap';
import type { MapProvider } from '../types';

const MapsPanel: React.FC = () => {
  const [activeProvider, setActiveProvider] = useState<MapProvider>('google');
  const [googleApiKey, setGoogleApiKey] = useState('');
  const [yandexApiKey, setYandexApiKey] = useState('');
  const [addressInput, setAddressInput] = useState('');
  const [zoomInput, setZoomInput] = useState('15');
  const [googleMapType, setGoogleMapType] = useState<'roadmap' | 'satellite' | 'hybrid' | 'terrain'>('satellite');
  const [yandexMapType, setYandexMapType] = useState<'map' | 'satellite' | 'hybrid'>('satellite');
  // Стиль подложки — рабочий провайдер без API-ключей (реестр TILE_PROVIDERS,
  // аудит audit/index.fixed.html): tile.openstreetmap.org и CartoDB УДАЛЕНЫ
  // (403 по Referer для github.io / требование ключа соответственно).
  const [osmTileServer, setOsmTileServer] = useState<TileServerId>(DEFAULT_TILE_SERVER);
  const [widthInput, setWidthInput] = useState('2048');
  const [heightInput, setHeightInput] = useState('2048');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Счётчик фоновых снимков: результат применяется только если это всё ещё
  // последний запрос (защита от гонки при быстром двойном нажатии)
  const loadSeqRef = useRef(0);

  const {
    project,
    setGoogleMapsApiKey,
    toggleGoogleMaps,
    setYandexMapsApiKey,
    toggleYandexMaps,
    setOSMTileServer,
    loadMapWithStorage,
    loadActiveTileMap,
    setMapBounds,
  } = useStore();

  // Инициализация API ключей из проекта
  React.useEffect(() => {
    if (project.googleMaps?.apiKey) {
      setGoogleApiKey(project.googleMaps.apiKey);
    }
    if (project.yandexMaps?.apiKey) {
      setYandexApiKey(project.yandexMaps.apiKey);
    }
    if (project.openStreetMap?.tileServer) {
      // legacy-значения ('osm', 'carto') нормализуются в рабочие серверы
      setOsmTileServer(normalizeTileServer(project.openStreetMap.tileServer));
    }
  }, [project]);

  const handleSaveGoogleApiKey = async () => {
    if (!googleApiKey.trim()) {
      setError('Введите API ключ Google Maps');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await loadGoogleMapsApi(googleApiKey.trim());
      setGoogleMapsApiKey(googleApiKey.trim());
      toggleGoogleMaps(true);
      setSuccess('Google Maps API ключ сохранён');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки Google Maps');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveYandexApiKey = async () => {
    if (!yandexApiKey.trim()) {
      setError('Введите API ключ Яндекс.Карт');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await loadYandexMapsApi(yandexApiKey.trim());
      setYandexMapsApiKey(yandexApiKey.trim());
      toggleYandexMaps(true);
      setSuccess('Яндекс.Карты API ключ сохранён');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки Яндекс.Карт');
    } finally {
      setLoading(false);
    }
  };



  const handleGeocode = async () => {
    if (!addressInput.trim()) {
      setError('Введите адрес');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      let result: { lat: number; lng: number } | null = null;

      if (activeProvider === 'google' && isGoogleMapsLoaded()) {
        result = await geocodeAddress(addressInput);
      } else if (activeProvider === 'yandex' && isYandexMapsLoaded()) {
        result = await yandexGeocode(addressInput);
      } else if (activeProvider === 'osm' || activeProvider === '2gis') {
        // 2ГИС-вкладка использует тот же бесплатный геокодер (Nominatim): у 2ГИС
        // публичного геокодинга без ключа нет, а тайлы — есть.
        const res = await osmGeocode(addressInput);
        result = res.point;
        if (!result) {
          setError(res.kind === 'not_found' ? 'Адрес не найден' : 'Сервис геокодирования недоступен. Попробуйте ещё раз.');
        }
      } else {
        setError('Провайдер не инициализирован');
        setLoading(false);
        return;
      }

      if (result) {
        setSuccess(`Координаты: ${result.lat.toFixed(6)}, ${result.lng.toFixed(6)}`);
      } else if (activeProvider !== 'osm') {
        setError('Адрес не найден');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка геокодирования');
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMap = async () => {
    if (!addressInput.trim()) {
      setError('Введите адрес или координаты');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      // Валидация размеров: без лимитов Google Static Maps вернёт ошибку размера,
      // Яндекс — 400, а OSM-конструктор соберёт тысячи тайлов (память/canvas-лимиты).
      const clampSize = (v: number, d: number) => Math.min(4096, Math.max(256, Number.isFinite(v) ? v : d));
      const width = clampSize(parseInt(widthInput), 2048);
      const height = clampSize(parseInt(heightInput), 2048);
      const zoom = Math.min(21, Math.max(1, parseInt(zoomInput) || 15));

      let geoResult: { lat: number; lng: number } | null = null;
      let mapResult: { dataUrl: string; bounds: any } | undefined;

      if (activeProvider === 'google') {
        if (!isGoogleMapsLoaded()) {
          setError('Google Maps API не загружен');
          setLoading(false);
          return;
        }

        geoResult = await geocodeAddress(addressInput);
        if (!geoResult) {
          setError('Адрес не найден');
          setLoading(false);
          return;
        }

        mapResult = await loadStaticMap(
          geoResult,
          zoom,
          width,
          height,
          project.googleMaps?.apiKey || '',
          googleMapType
        );

        await loadMapWithStorage({
          name: `Google Maps - ${addressInput}`,
          width,
          height,
          dataUrl: mapResult.dataUrl,
          bounds: mapResult.bounds,
          source: 'google',
        });
      } else if (activeProvider === 'yandex') {
        if (!isYandexMapsLoaded()) {
          setError('Яндекс.Карты API не загружен');
          setLoading(false);
          return;
        }

        geoResult = await yandexGeocode(addressInput);
        if (!geoResult) {
          setError('Адрес не найден');
          setLoading(false);
          return;
        }

        mapResult = await loadYandexStaticMap(
          geoResult,
          zoom,
          width,
          height,
          project.yandexMaps?.apiKey || '',
          yandexMapType
        );

        await loadMapWithStorage({
          name: `Яндекс.Карты - ${addressInput}`,
          width,
          height,
          dataUrl: mapResult.dataUrl,
          bounds: mapResult.bounds,
          source: 'yandex',
        });
      } else if (activeProvider === '2gis') {
        // ЗАГРУЗКА КАРТ «2ГИС»: хост tile-b01.2gis.com не резолвится (ERR_NAME_NOT_RESOLVED),
        // поэтому слой рендерит бесплатную подложку Esri World Street Map (ключ НЕ требуется).
        // Тайлсервер фиксируется в сторе, после чего
        // создается активная тайловая карта с той же строгой Mercator-привязкой,
        // что и OSM — точки/маршруты ставятся по реальным координатам.
        setOSMTileServer('2gis');
        const geoRes = await osmGeocode(addressInput);
        geoResult = geoRes.point;
        if (!geoResult) {
          setError(geoRes.kind === 'not_found' ? 'Место не найдено.' : 'Сервис геокодирования временно недоступен. Попробуйте ещё раз.');
          setLoading(false);
          return;
        }
        loadActiveTileMap(geoResult, zoom);
        useStore.setState((cur) => ({
          project: cur.project.map
            ? { ...cur.project, map: { ...cur.project.map, source: '2gis' } }
            : cur.project,
        }));
        setSuccess('Карта 2ГИС загружена: доступен зум и панорама, привязка к координатам строгая.');
        return;
      } else if (activeProvider === 'osm') {
        // ПРОСТАЯ ЗАГРУЗКА KAK НА OPENSTREETMAP.ORG: вместо «фотографии»-стоп-кадра
        // (сотни тайлов в один большой PNG — медленно и с потерей чёткости при зуме)
        // создаётся АКТИВНАЯ тайловая карта: подложка грузится тайлами динамически,
        // непрерывно масштабируется колесом от z3 до z19+ и жёстко привязана к
        // координатам единой Web Mercator-формулой (worldPx = 256·2^z).
        const geoRes = await osmGeocode(addressInput);
        geoResult = geoRes.point;
        if (!geoResult) {
          setError(geoRes.kind === 'not_found' ? 'Адрес не найден.' : 'Сервис геокодирования временно недоступен. Попробуйте ещё раз.');
          setLoading(false);
          return;
        }

        loadActiveTileMap(geoResult, zoom);
        // Legacy-значение «2gis» normalizeTileServer() маппит на Esri World Street Map
        // (публичный тайловый сервис 2ГИС закрыт). Источник помечаем для бейджа/статистики.
        if (osmTileServer === ('2gis' as TileServerId)) {
          useStore.setState((cur) => ({
            project: cur.project.map
              ? { ...cur.project, map: { ...cur.project.map, source: '2gis' } }
              : cur.project,
          }));
        } else {
          useStore.setState((cur) => ({
            project: cur.project.map
              ? { ...cur.project, map: { ...cur.project.map, source: 'osm' } }
              : cur.project,
          }));
        }

        // Снимок-подложка для OSM НЕ загружается: активная тайловая карта уже
        // является основной подложкой (как на openstreetmap.org). Фоновый big-PNG
        // ранее перезаписывал виртуальный растр и сбивал вид при каждом открытии —
        // именно это делало карту «невидимой» после панорамирования/зума.

        // Привязка уже установлена loadActiveTileMap (точная Mercator); setMapBounds
        // здесь не нужен — иначе стёр бы bounds до прихода фонового снимка.
        setSuccess('Карта открыта (как на openstreetmap.org): доступен зум и панорама, привязка к координатам строгая.');
        return;
      }

      // mapResult может остаться undefined, если activeProvider не совпал ни с
      // одной веткой (например 'local') — сообщаем об этом вместо тихого «успеха»
      // с non-null assertion.
      if (mapResult) {
        setMapBounds(mapResult.bounds);
        setSuccess('Карта успешно загружена!');
      } else {
        setError(`Провайдер «${activeProvider}» не поддерживает загрузку статической карты`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки карты');
    } finally {
      setLoading(false);
    }
  };

  const providers = [
    { id: 'google' as MapProvider, name: 'Google', icon: '🌍', enabled: project.googleMaps?.enabled },
    { id: 'yandex' as MapProvider, name: 'Яндекс', icon: '🗺️', enabled: project.yandexMaps?.enabled },
    { id: 'osm' as MapProvider, name: 'OSM', icon: '🌐', enabled: project.openStreetMap?.enabled },
    { id: '2gis' as MapProvider, name: '2ГИС', icon: '🧭', enabled: project.openStreetMap?.tileServer === '2gis' },
  ];

  return (
    <div className="p-3 space-y-3">
      <h3 className="text-sm font-medium text-cyan-400">🗺️ Карты</h3>

      {/* Provider tabs */}
      <div className="flex gap-1">
        {providers.map(provider => (
          <button
            key={provider.id}
            onClick={() => {
              setActiveProvider(provider.id);
              setError('');
              setSuccess('');
            }}
            className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
              activeProvider === provider.id
                ? 'bg-cyan-600 text-white'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
            }`}
          >
            {provider.icon} {provider.name}
            {provider.enabled && <span className="ml-1 text-green-400">✓</span>}
          </button>
        ))}
      </div>

      {/* API Key section */}
      {activeProvider === 'google' && (
        <form
          onSubmit={(e) => { e.preventDefault(); handleSaveGoogleApiKey(); }}
          autoComplete="off"
        >
          <label className="text-xs text-gray-400 block mb-1">API ключ Google Maps</label>
          <div className="flex gap-1">
            <input
              type="password"
              name="google-maps-key"
              autoComplete="new-password"
              value={googleApiKey}
              onChange={(e) => setGoogleApiKey(e.target.value)}
              placeholder="Введите API ключ"
              className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white placeholder-gray-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded text-xs"
            >
              {loading ? '...' : 'OK'}
            </button>
          </div>
        </form>
      )}

      {activeProvider === 'yandex' && (
        <form
          onSubmit={(e) => { e.preventDefault(); handleSaveYandexApiKey(); }}
          autoComplete="off"
        >
          <label className="text-xs text-gray-400 block mb-1">API ключ Яндекс.Карт</label>
          <div className="flex gap-1">
            <input
              type="password"
              name="yandex-maps-key"
              autoComplete="new-password"
              value={yandexApiKey}
              onChange={(e) => setYandexApiKey(e.target.value)}
              placeholder="Введите API ключ"
              className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white placeholder-gray-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded text-xs"
            >
              {loading ? '...' : 'OK'}
            </button>
          </div>
        </form>
      )}

      {activeProvider === 'osm' && (
        <div>
          <label className="text-xs text-gray-400 block mb-1" htmlFor="osm-tile-server">Сервер тайлов (рабочие, без ключей)</label>
          <select
            id="osm-tile-server"
            aria-label="Сервер тайлов подложки карты"
            value={osmTileServer}
            onChange={(e) => {
              const value = normalizeTileServer(e.target.value);
              setOsmTileServer(value);
              setOSMTileServer(value);
            }}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
          >
            {TILE_SERVER_ORDER.map((id) => (
              <option key={id} value={id}>{TILE_PROVIDERS[id].label}</option>
            ))}
          </select>
          <p className="text-xs text-green-400 mt-2">✓ Все стили работают по HTTPS без API-ключей; стиль по умолчанию — Esri (самый стабильный)</p>
        </div>
      )}

      {/* Address input */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">Адрес или координаты</label>
        <div className="flex gap-1">
          <input
            type="text"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            placeholder="Москва, Красная площадь"
            className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white placeholder-gray-500"
          />
          <button
            onClick={handleGeocode}
            disabled={loading}
            className="px-3 py-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white rounded text-xs"
          >
            {loading ? '...' : '🔍'}
          </button>
        </div>
      </div>

      {/* Map settings */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Зум (1-21)</label>
          <input
            type="number"
            min="1"
            max="21"
            value={zoomInput}
            onChange={(e) => setZoomInput(e.target.value)}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Тип карты</label>
          {activeProvider === 'google' && (
            <select
              value={googleMapType}
              onChange={(e) => setGoogleMapType(e.target.value as any)}
              className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
            >
              <option value="satellite">Спутник</option>
              <option value="roadmap">Схема</option>
              <option value="hybrid">Гибрид</option>
              <option value="terrain">Рельеф</option>
            </select>
          )}
          {activeProvider === 'yandex' && (
            <select
              value={yandexMapType}
              onChange={(e) => setYandexMapType(e.target.value as any)}
              className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
            >
              <option value="satellite">Спутник</option>
              <option value="map">Схема</option>
              <option value="hybrid">Гибрид</option>
            </select>
          )}
          {activeProvider === 'osm' && (
            <select
              aria-label="Стиль подложки карты"
              value={osmTileServer}
              onChange={(e) => {
                const value = normalizeTileServer(e.target.value);
                setOsmTileServer(value);
                setOSMTileServer(value);
              }}
              className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
            >
              {TILE_SERVER_ORDER.map((id) => (
                <option key={id} value={id}>{TILE_PROVIDERS[id].label}</option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Ширина (px)</label>
          <input
            type="number"
            value={widthInput}
            onChange={(e) => setWidthInput(e.target.value)}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Высота (px)</label>
          <input
            type="number"
            value={heightInput}
            onChange={(e) => setHeightInput(e.target.value)}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
          />
        </div>
      </div>

      {/* Load map button */}
      <button
        onClick={handleLoadMap}
        disabled={loading || (activeProvider !== 'osm' && activeProvider !== '2gis' && !providers.find(p => p.id === activeProvider)?.enabled)}
        className="w-full px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white rounded text-sm font-medium"
      >
        {loading ? 'Загрузка...' : `🗺️ Загрузить карту ${providers.find(p => p.id === activeProvider)?.name}`}
      </button>

      {/* Status messages */}
      {error && (
        <div className="p-2 bg-red-900/30 border border-red-500 rounded text-xs text-red-300">
          ❌ {error}
        </div>
      )}
      {success && (
        <div className="p-2 bg-green-900/30 border border-green-500 rounded text-xs text-green-300">
          ✓ {success}
        </div>
      )}

      {/* Info */}
      <div className="p-2 bg-gray-700 rounded text-xs text-gray-400">
        <p className="font-medium text-gray-300 mb-1">ℹ️ Информация:</p>
        {activeProvider === 'google' && (
          <div className="space-y-0.5">
            <p>• Получите ключ на <a href="https://console.cloud.google.com/" target="_blank" rel="noopener" className="text-cyan-400 hover:underline">Google Cloud</a></p>
            <p>• Включите: Maps JavaScript API, Geocoding API</p>
            <p>• Ключ хранится локально</p>
          </div>
        )}
        {activeProvider === 'yandex' && (
          <div className="space-y-0.5">
            <p>• Получите ключ на <a href="https://developer.tech.yandex.ru/" target="_blank" rel="noopener" className="text-cyan-400 hover:underline">Яндекс.Карты API</a></p>
            <p>• Бесплатный тариф: 25 000 запросов/день</p>
            <p>• Ключ хранится локально</p>
          </div>
        )}
        {activeProvider === 'osm' && (
          <div className="space-y-0.5">
            <p>• Не требует API ключа</p>
            <p>• Esri Street — стиль по умолчанию (самый стабильный на GitHub Pages)</p>
            <p>• OSM France / Germany, OpenTopoMap, CyclOSM — рабочие зеркала без 403</p>
            <p>• Геокодер: Nominatim с фоллбэком при недоступности (1 запрос/сек)</p>
            <p>• Уважайте правила использования серверов тайлов</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default MapsPanel;
