import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import { loadGoogleMapsApi, geocodeAddress, loadStaticMap, isGoogleMapsLoaded } from '../utils/googleMaps';

const GoogleMapsPanel: React.FC = () => {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [addressInput, setAddressInput] = useState('');
  const [zoomInput, setZoomInput] = useState('15');
  const [mapTypeInput, setMapTypeInput] = useState<'roadmap' | 'satellite' | 'hybrid' | 'terrain'>('satellite');
  const [widthInput, setWidthInput] = useState('2048');
  const [heightInput, setHeightInput] = useState('2048');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const {
    project,
    setGoogleMapsApiKey,
    toggleGoogleMaps,
    loadMap,
    setMapBounds,
  } = useStore();

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) {
      setError('Введите API ключ');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await loadGoogleMapsApi(apiKeyInput.trim());
      setGoogleMapsApiKey(apiKeyInput.trim());
      toggleGoogleMaps(true);
      setSuccess('API ключ сохранён и Google Maps загружен');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки Google Maps');
    } finally {
      setLoading(false);
    }
  };

  const handleGeocode = async () => {
    if (!addressInput.trim()) {
      setError('Введите адрес');
      return;
    }

    if (!isGoogleMapsLoaded()) {
      setError('Google Maps API не загружен. Сначала сохраните API ключ.');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const result = await geocodeAddress(addressInput);
      if (result) {
        setSuccess(`Координаты: ${result.lat.toFixed(6)}, ${result.lng.toFixed(6)}`);
        // Можно использовать эти координаты для загрузки карты
      } else {
        setError('Адрес не найден');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка геокодирования');
    } finally {
      setLoading(false);
    }
  };

  const handleLoadGoogleMap = async () => {
    if (!isGoogleMapsLoaded()) {
      setError('Google Maps API не загружен. Сначала сохраните API ключ.');
      return;
    }

    if (!addressInput.trim()) {
      setError('Введите адрес или координаты');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      // Пытаемся геокодировать адрес
      const geoResult = await geocodeAddress(addressInput);
      if (!geoResult) {
        setError('Адрес не найден');
        setLoading(false);
        return;
      }

      const width = parseInt(widthInput) || 2048;
      const height = parseInt(heightInput) || 2048;
      const zoom = parseInt(zoomInput) || 15;

      // Загружаем статическую карту
      const mapResult = await loadStaticMap(
        geoResult,
        zoom,
        width,
        height,
        project.googleMaps.apiKey,
        mapTypeInput
      );

      // Создаём MapData
      loadMap({
        name: `Google Maps - ${addressInput}`,
        width: mapResult.dataUrl ? width : 0,
        height: mapResult.dataUrl ? height : 0,
        dataUrl: mapResult.dataUrl,
        bounds: mapResult.bounds,
        source: 'google',
      });

      setMapBounds(mapResult.bounds);
      setSuccess('Карта Google Maps загружена!');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки карты');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-3 space-y-3">
      <h3 className="text-sm font-medium text-cyan-400">🌍 Google Maps</h3>

      {/* API Key */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">API ключ Google Maps</label>
        <div className="flex gap-1">
          <input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="Введите API ключ"
            className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white placeholder-gray-500"
          />
          <button
            onClick={handleSaveApiKey}
            disabled={loading}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded text-xs"
          >
            {loading ? '...' : 'Сохранить'}
          </button>
        </div>
        {project.googleMaps.enabled && (
          <p className="text-xs text-green-400 mt-1">✓ Google Maps активен</p>
        )}
      </div>

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
          <select
            value={mapTypeInput}
            onChange={(e) => setMapTypeInput(e.target.value as any)}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white"
          >
            <option value="satellite">Спутник</option>
            <option value="roadmap">Схема</option>
            <option value="hybrid">Гибрид</option>
            <option value="terrain">Рельеф</option>
          </select>
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
        onClick={handleLoadGoogleMap}
        disabled={loading || !project.googleMaps.enabled}
        className="w-full px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white rounded text-sm font-medium"
      >
        {loading ? 'Загрузка...' : '🗺️ Загрузить карту Google Maps'}
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
        <p className="font-medium text-gray-300 mb-1">ℹ️ Как получить API ключ:</p>
        <ol className="list-decimal list-inside space-y-0.5">
          <li>Перейдите на <a href="https://console.cloud.google.com/" target="_blank" rel="noopener" className="text-cyan-400 hover:underline">Google Cloud Console</a></li>
          <li>Создайте проект или выберите существующий</li>
          <li>Включите "Maps JavaScript API" и "Geocoding API"</li>
          <li>Создайте API ключ в разделе "Credentials"</li>
          <li>Скопируйте ключ и вставьте выше</li>
        </ol>
        <p className="mt-2 text-yellow-400">⚠️ API ключ хранится локально в браузере</p>
      </div>
    </div>
  );
};

export default GoogleMapsPanel;
