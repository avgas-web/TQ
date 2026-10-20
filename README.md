# TotalQuadro Mission Planner

Веб-приложение **планировщика миссий БПЛА** для игры «ТоталКвадро»: полноценный оффлайн-инструмент проектирования полётных заданий на реальных геокартах — от рисования зон и маршрутов до расчёта высот, проверки совместимости с флотом дронов и экспорта в MAVLink.

## 🌟 Ключевой функционал

### Мастер планирования миссии (3-панельный UI)
Левая панель **Sidebar** — управление проектом, зонами и флотом; центральная **MapCanvas** — интерактивная карта (Leaflet/оверлейные слои провайдеров); правая **MissionPanel** — пошаговый мастер миссии: выбор режима, оптимизация маршрута, расчёт высот, симуляция и запуск (`launchMission`).

### Маршрутизация в Web Worker
Расчёт маршрутов (**A\***, **RRT**, **Visibility graph**) вынесен в `src/workers/routing.worker.ts` — главный поток не блокируется даже на сложных полигонах NFZ (no-fly zones). Протокол сообщений типизирован (`routingProtocol.ts`), ошибки воркера возвращаются в UI как понятные сообщения (try/catch внутри воркера). Хук-обёртка — `src/hooks/useRoutingWorker.ts`.

### Профили высот (Open-Elevation)
Компонент `AltitudeProfile` строит SVG-профиль «рельеф + высота полёта» по маршруту. Пакетные запросы к Open-Elevation защищены от гонок: `AbortController` + счётчик `altitudeRunId` гарантируют, что устаревший пересчёт не перезапишет `routeWarnings`, а дедупликация исключает повторные сетевые батчи. Поддерживается `applyVerticalLimits` (AGL/ABS, ограничения по дрону).

### Управление флотом и миссиями
Профили дронов (`src/utils/droneProfiles.ts`) задают дальность, крейсерскую скорость и потолки. Назначение long-range миссии (>100 км) на short-range дрон генерирует **hard error** в `routeWarnings` и **блокирует смену режима** миссии — а не мягкое предупреждение.

### Экспорт MAVLink и форматов
Экспорт маршрутов в **MAVLink** (QGC/WP-Mission совместимый), а также CSV, JSON, GeoJSON, GPX, KML (`src/utils/export.ts`).

### Валидация данных и состояние
- Стор на **Zustand v5** с persist в localStorage (`src/store/useStore.ts`); безопасная инициализация через `src/hooks/useStoreShim.ts` (без вызова `getState()` до гидратации).
- Импорт/загрузка проектов проходит zod-валидацию (`src/utils/projectSchema.ts`): битые данные (NaN, отсутствующие поля, out-of-bounds lat/lon) возвращают `{ ok: false, errors: [...] }` вместо краша; `parseViewState` применяет безопасные дефолты.
- Глобальный флаг **`isProcessing`**: во время аплоада (оптимизация, пересчёт высот, запуск миссии) кнопки удаления зон, оптимизации и пересчёта физически `disabled` в DOM, а мутации стейта блокируются `makeGuarded()`.

### Карты
Три провайдера подложки: **Google Maps**, **Яндекс.Карты**, **OpenStreetMap** (спутник/схема/гибрид), ключи — через `.env` (в git не попадают).

## 🚀 Запуск

```bash
npm ci
npm run dev        # локальная разработка
npm run build      # production-сборка в dist/
npm run preview    # предпросмотр сборки
```

## ✅ Проверки качества

```bash
npm run lint       # ESLint (flat config)
npm run typecheck  # tsc --noEmit
npm run test       # Vitest (happy-dom), tests/
```

Pre-commit хук (`.husky/pre-commit`) автоматически запускает `lint-staged`.

## 📁 Структура проекта

```
src/
├── components/          # UI: Sidebar, MapCanvas, MissionPanel, AltitudeProfile,
│                        # Toolbar, StatusBar, MapsPanel, MiniMapPanel
├── hooks/               # useRoutingWorker (мост к воркеру), useStoreShim (безопасный доступ к store)
├── store/               # useStore.ts — Zustand v5 + persist, isProcessing/guards
├── utils/               # projectSchema (zod), droneProfiles, routing, elevation,
│                        # geometry, mission, export (MAVLink/CSV/KML…), storage, карты провайдеров
├── workers/             # routing.worker.ts + routingProtocol.ts (типизированный RPC)
├── types/               # общие типы домена
tests/                   # Vitest: схема+дефолты, гонки высот, воркер, флот, UI-guards
vitest.config.ts         # окружение happy-dom
eslint.config.js         # flat-config ESLint
```

## 🔒 Гигиена репозитория
В `.gitignore` исключены `.env*`, `coverage/`, `.tmp-tests/`, `dist/` — секреты и артефакты не попадают в историю.
