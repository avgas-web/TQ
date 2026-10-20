# TotalQuadro Mission Planner

Планировщик миссий БПЛА для игры «ТоталКвадро»: прокладка маршрутов с облётом NFZ, профили высот, управление флотом дронов и экспорт MAVLink.

## 🌟 Возможности

- **3-панельный мастер миссии** — маршрут → высота → флот/запуск (Sidebar / MapCanvas+MiniMap / MissionPanel)
- **Маршрутизация в Web Worker** (`src/workers/routing.worker.ts`) — A*, RRT и Visibility Graph вынесены из главного потока; синхронный fallback при недоступности воркера
- **Профили высот** — пакетные запросы к Open-Elevation с race-guard'ами (`altitudeRunId` + `AbortController`), график рельефа и ограничения по высоте (`applyVerticalLimits`)
- **Управление флотом** — профили дронов (`droneProfiles.ts`): long-range миссии (>100 км) на short-range дроне блокируются hard-error'ом в `routeWarnings`
- **NFZ-зоны** — рисование полигонов запретных зон, авто-облёт, валидация через Zod
- **Валидация данных** — `projectSchema.ts` (zod): битые проекты возвращают `{ ok:false, errors[] }`, а не крашат приложение; Zustand v5 persist защищён шимом (`useStoreShim`)
- **Экспорт** — MAVLink-совместимый формат, GeoJSON/KML проектов
- **UI-гарды** — во время аплоада (`isProcessing`) кнопки удаления зон, оптимизации и пересчёта высот заблокированы

## 🚀 Запуск

```bash
npm ci
npm run dev        # vite dev-server
npm run build      # production build → dist/
npm test           # unit-тесты логики (mission, droneProfiles)
npm run typecheck  # tsc --noEmit
```

## 📁 Структура проекта

```
src/
├── components/   # Sidebar, MissionPanel, MapCanvas, MiniMapPanel, AltitudeProfile…
├── hooks/        # useRoutingWorker, useAppInitialization, useMapInteractions, useCanvasRenderer
├── store/        # Zustand-сторы: useStore, useMissionStore, useFleetStore, useMapStore, useStoreShim
├── utils/        # projectSchema (zod), droneProfiles, elevation, routing, mission, export, geometry…
├── workers/      # routing.worker.ts — тяжёлые алгоритмы вне главного потока
└── types/        # общие TypeScript-типы
tests/            # unit-тесты чистой логики
```

## 🔒 Гигиена репозитория

`.env*`, `coverage/`, `.tmp-tests/`, `dist/`, `node_modules/` исключены из VCS. Секреты не коммитятся.
