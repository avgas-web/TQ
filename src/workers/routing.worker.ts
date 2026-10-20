// Web Worker маршрутизации: расчёт облёта зон (visibility graph + A*-подобный
// поиск в src/utils/routing.ts) выполняется ВНЕ главного потока — UI с Leaflet-
// канвасом не блокируется на больших полигонах NFZ.
// Контракт протокола см. в src/workers/routingProtocol.ts.
/// <reference lib="webworker" />
import { planPathAroundZones } from '../utils/routing';
import type { RoutingRequest, RoutingResponse } from './routingProtocol';

self.onmessage = (ev: MessageEvent<RoutingRequest>) => {
  const req = ev.data;
  const res: RoutingResponse = { id: req?.id ?? -1, ok: false };
  try {
    if (!req || !Array.isArray(req.restrictions) || !req.start || !req.goal) {
      throw new Error('Некорректный запрос маршрутизации: start/goal/restrictions обязательны');
    }
    if (!Number.isFinite(req.mapW) || !Number.isFinite(req.mapH) || req.mapW <= 0 || req.mapH <= 0) {
      throw new Error(`Недопустимые размеры карты: ${req.mapW}×${req.mapH}`);
    }
    // Сложные/битые полигоны NFZ не должны ронять воркер: любая внутренняя
    // ошибка превращается в понятное сообщение главному потоку.
    const path = planPathAroundZones(req.start, req.goal, req.restrictions, req.mapW, req.mapH);
    res.ok = true;
    res.path = path;
  } catch (e) {
    res.error = `Ошибка воркера маршрутизации: ${(e as Error)?.message ?? String(e)}`;
  }
  // postMessage обязателен даже при отказе — иначе промис клиента «висит» вечно
  (self as unknown as Worker).postMessage(res);
};
