// ─── Пользовательские тактические карты: UI-слой (хук) ──────────────────────
// Инкапсулирует загрузку файлов (GeoJSON/KML/KMZ/GeoTIFF/MBTiles/PNG-JPG),
// ручную привязку растров по 4 углам, прогресс, ошибки и персистентность.
// Слой хранится в zustand-проекте (методы add/update/removeUserLayer), бинарники —
// в IndexedDB; сюда попадают только события загрузки и состояние диалога.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UserMapLayer } from '../types';
import { useStore } from '../store/useStore';
import {
  loadUserMapFile, detectFormat, ACCEPT_EXTENSIONS, UnsupportedMapFormatError,
  type LoadProgress,
} from '../utils/userMapLoader';
import type { CornerCalibration } from '../utils/userMapGeo';
import {
  validateUserLayerSize, USER_LAYER_LIMITS, getUserLayersTotalBytes, formatBytes,
} from '../utils/storage';

export interface UserMapsState {
  /** Идёт ли загрузка/декодирование файла */
  loading: boolean;
  /** Прогресс текущей загрузки (0..1) и стадия */
  progress: { ratio: number; phase: LoadProgress['phase'] | null };
  /** Текст последней ошибки (для тоста) */
  error: string | null;
  /** Файл, ожидающий ручной привязки по 4 углам (PNG/JPG без координат) */
  pendingCalibration: { file: File; fileName: string } | null;
  /** Суммарный объём сохранённых слоёв, байт */
  totalBytes: number;
}

/** Подсказка для input[accept] */
export const USER_MAP_ACCEPT = ACCEPT_EXTENSIONS;

/** Человекочитаемое имя формата */
export function formatLabel(fmt: string | null): string {
  switch (fmt) {
    case 'geojson': return 'GeoJSON';
    case 'kml': return 'KML';
    case 'kmz': return 'KMZ (архив KML)';
    case 'geotiff': return 'GeoTIFF';
    case 'mbtiles': return 'MBTiles';
    case 'image': return 'Растр (PNG/JPG)';
    default: return 'неизвестный формат';
  }
}

export function useUserMaps() {
  const userLayers = useStore((s) => s.project.userLayers ?? []);
  const addOrUpdateUserLayer = useStore((s) => s.addOrUpdateUserLayer);
  const removeUserLayer = useStore((s) => s.removeUserLayer);
  const setUserLayerVisible = useStore((s) => s.setUserLayerVisible);
  const setUserLayerOpacity = useStore((s) => s.setUserLayerOpacity);
  const focusUserLayer = useStore((s) => s.focusUserLayer);
  const restoreUserLayers = useStore((s) => s.restoreUserLayers);

  const [state, setState] = useState<UserMapsState>({
    loading: false, progress: { ratio: 0, phase: null }, error: null,
    pendingCalibration: null, totalBytes: 0,
  });
  /** Отмена незавершённой загрузки (закрытие диалога / новая загрузка) */
  const abortRef = useRef<AbortController | null>(null);

  // суммарный объём при старте и после изменений состава слоёв
  useEffect(() => {
    let alive = true;
    void getUserLayersTotalBytes().then((b) => { if (alive) setState((s) => ({ ...s, totalBytes: b })); });
    return () => { alive = false; };
  }, [userLayers.length]);

  const clearAbortStatusInner = useCallback(() => {
    setState((s) => ({ ...s, loading: false, progress: { ratio: 0, phase: null }, error: null }));
  }, []);

  /** Загрузка файла слоя «как есть» (все форматы, кроме PNG/JPG без привязки) */
  const loadFile = useCallback(async (file: File, meta?: { name?: string; author?: string }) => {
    const fmt = detectFormat(file.name);
    if (!fmt) {
      setState((s) => ({ ...s, error: new UnsupportedMapFormatError(file.name).message }));
      return null;
    }
    const sizeErr = validateUserLayerSize(file.size, file.name);
    if (sizeErr) {
      setState((s) => ({ ...s, error: sizeErr }));
      return null;
    }
    if (userLayers.length >= USER_LAYER_LIMITS.maxLayers) {
      setState((s) => ({
        ...s,
        error: `Достигнут предел ${USER_LAYER_LIMITS.maxLayers} слоёв — удалите неактуальные тактические карты`,
      }));
      return null;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState((s) => ({ ...s, loading: true, error: null, progress: { ratio: 0, phase: 'read' } }));

    try {
      const layer = await loadUserMapFile(file, {
        name: meta?.name, author: meta?.author,
        onProgress: (p) => {
          if (ac.signal.aborted) return;
          setState((s) => ({ ...s, progress: { ratio: p.ratio, phase: p.phase } }));
        },
      });
      if (ac.signal.aborted) return null;
      // растр без встроенной привязки требует 4 угловых точек
      if (layer.format === 'image' && !layer.calibration) {
        setState((s) => ({
          ...s, loading: false, progress: { ratio: 0, phase: null },
          pendingCalibration: { file, fileName: file.name },
        }));
        return null;
      }
      await addOrUpdateUserLayer(layer);
      setState((s) => ({ ...s, loading: false, progress: { ratio: 1, phase: 'done' }, error: null }));
      void getUserLayersTotalBytes().then((b) => setState((s) => ({ ...s, totalBytes: b })));
      return layer;
    } catch (e) {
      if (ac.signal.aborted) return null;
      const msg = e instanceof Error ? e.message : String(e);
      setState((s) => ({ ...s, loading: false, progress: { ratio: 0, phase: null }, error: msg }));
      return null;
    }
  }, [addOrUpdateUserLayer, userLayers.length]);

  /** Завершение ручной привязки PNG/JPG по четырём углам */
  const confirmCalibration = useCallback(async (corners: CornerCalibration, meta?: { name?: string; author?: string }) => {
    const pending = state.pendingCalibration;
    if (!pending) return null;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const layer = await loadUserMapFile(pending.file, {
        calibration: corners, name: meta?.name, author: meta?.author,
      });
      await addOrUpdateUserLayer(layer);
      setState((s) => ({ ...s, loading: false, pendingCalibration: null, progress: { ratio: 1, phase: 'done' } }));
      return layer;
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }, [addOrUpdateUserLayer, state.pendingCalibration]);

  const cancelCalibration = useCallback(() => {
    setState((s) => ({ ...s, pendingCalibration: null, error: null, loading: false }));
  }, []);

  /** Удалить слой (данные чистятся стором в IndexedDB) */
  const dropLayer = useCallback(async (id: string) => {
    await removeUserLayer(id);
    const b = await getUserLayersTotalBytes();
    setState((s) => ({ ...s, totalBytes: b }));
  }, [removeUserLayer]);

  /** Восстановить данные слоёв из IndexedDB после перезагрузки страницы */
  const hydrate = useCallback(() => restoreUserLayers(), [restoreUserLayers]);

  return {
    layers: userLayers,
    ...state,
    loadFile,
    confirmCalibration,
    cancelCalibration,
    dropLayer,
    setVisible: setUserLayerVisible,
    setOpacity: setUserLayerOpacity,
    focus: focusUserLayer,
    hydrate,
    clearAbortStatus: clearAbortStatusInner,
    limits: USER_LAYER_LIMITS,
    formatBytes,
  } as {
    layers: UserMapLayer[];
  } & UserMapsState & {
    loadFile: (file: File, meta?: { name?: string; author?: string }) => Promise<UserMapLayer | null>;
    confirmCalibration: (c: CornerCalibration, m?: { name?: string; author?: string }) => Promise<UserMapLayer | null>;
    cancelCalibration: () => void;
    dropLayer: (id: string) => Promise<void>;
    setVisible: (id: string, visible: boolean) => void;
    setOpacity: (id: string, opacity: number) => void;
    focus: (id: string) => void;
    hydrate: () => Promise<void>;
    clearAbortStatus: () => void;
    limits: typeof USER_LAYER_LIMITS;
    formatBytes: typeof formatBytes;
  };
}
