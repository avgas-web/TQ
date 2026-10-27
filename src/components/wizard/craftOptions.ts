// Каталог типов аппаратов Этапа 1.
export interface CraftOptionPublic {
  type: 'drone' | 'uav';
  name: string;
  maxRange: number; // км
  description: string;
  icon: string;
  batteryInfo?: string;
  engineInfo?: string;
}

export const CRAFT_OPTIONS: CraftOptionPublic[] = [
  {
    type: 'drone',
    name: 'Дрон (мультикоптер)',
    maxRange: 100,
    description: 'Электрический квадрокоптер для локальных миссий: съёмка, инспекция, доставка.',
    icon: '🛸',
    batteryInfo: 'Липоль 6S 16000 мАч · ~45 мин полёта',
  },
  {
    type: 'uav',
    name: 'БПЛА (самолётного типа)',
    maxRange: 100000,
    description: 'Тяжёлый БПЛА самолётной схемы для протяжённых и межрегиональных миссий.',
    icon: '✈️',
    engineInfo: 'Турбовинтовой · крейсер 180 км/ч · потолок 6000 м',
  },
];

export const craftMaxRangeMeters = (t: 'drone' | 'uav'): number =>
  (CRAFT_OPTIONS.find((c) => c.type === t)?.maxRange ?? 0) * 1000;
