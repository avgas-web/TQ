#!/usr/bin/env node
/**
 * ЭТАП 3. Милитаризация терминологии (Game/Casual -> Combat/Tactical).
 *
 * Использование:
 *   node scripts/rename-terminology.mjs            # dry-run (сводка по файлам)
 *   node scripts/rename-terminology.mjs --apply    # применить замены + git mv
 *   node scripts/rename-terminology.mjs --apply --report
 *
 * Гарантии:
 *  - README.md исключён чёрным списком (не читается на запись, не правится);
 *  - идентификаторы меняются только целиком (границы слов), «шапка» регистра
 *    переносится автоматически (Drone->Asset, DRONE->ASSET, drone->asset);
 *  - persist/localStorage ключи здесь не переименовываются: обратная
 *    совместимость обеспечивается миграцией в src/utils/storage.ts.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, extname } from 'node:path';

const ROOT = process.cwd();
const APPLY = process.argv.includes('--apply');
const REPORT = process.argv.includes('--report');

/** Абсолютный запрет: эти пути никогда не изменяются. */
const BLACKLIST = ['README.md', join('scripts', 'rename-terminology.mjs')];

const SCAN_DIRS = ['src', 'tests', 'components'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css'];

/** Таблица замен идентификаторов. Порядок важен: сначала более длинные формы. */
const IDENT_MAP = [
  ['MissionWizard', 'CombatTacticalPlanner'],
  ['missionWizard', 'combatTacticalPlanner'],
  ['wizardState', 'plannerState'],
  ['wizardStep', 'plannerStep'],
  ['FleetDrone', 'CombatAssetUnit'],
  ['DroneAssignment', 'CombatAssetAssignment'],
  ['DroneSim', 'CombatAssetSim'],
  ['droneSim', 'combatAssetSim'],
  ['droneAssignments', 'combatAssetAssignments'],
  ['droneAssignment', 'combatAssetAssignment'],
  ['droneStarts', 'combatAssetStarts'],
  ['droneGoals', 'strikeObjectives'],
  ['droneCount', 'assetCount'],
  ['droneId', 'assetId'],
  ['drones', 'combatAssets'],
  ['drone', 'combatAsset'],
  ['simCycle', 'tacticalSimulationCycle'],
  ['simulation', 'tacticalSimulation'],
  ['routePoints', 'tacticalNodes'],
  ['waypoints', 'tacticalNodes'],
  ['draftRoutePts', 'projectionNodePts'],
  ['draftPoints', 'projectionNodes'],
  ['draftLine', 'projectionLine'],
  ['draftRoute', 'tacticalProjection'],
  ['routeDraft', 'tacticalProjection'],
  ['swarmGoal', 'strikeObjective'],
  ['swarmGoals', 'strikeObjectives'],
  ['nfzList', 'adizList'],
  ['nfzId', 'adizId'],
  ['NFZ', 'ADIZ'],
  ['gameLoop', 'combatCycle'],
  ['resetProject', 'abortMission'],
  ['resetAll', 'abortMission'],
];

/** Русские/английские UI-строки (точные фразы). */
const PHRASE_MAP = [
  ['Мастер миссии', 'Оперативный планировщик'],
  ['мастер миссии', 'оперативный планировщик'],
  ['Мастер построения маршрута', 'Планировщик боевого курса'],
  ['Симуляция пролёта', 'Боевое моделирование'],
  ['Симуляция', 'Боевое моделирование'],
  ['симуляция', 'боевое моделирование'],
  ['Дроны', 'Боевые аппараты'],
  ['дроны', 'боевые аппараты'],
  ['Дрон', 'Боевой аппарат'],
  ['дрон', 'боевой аппарат'],
  ['Точки маршрута', 'Узлы боевого курса'],
  ['точки маршрута', 'узлы боевого курса'],
  ['Точка маршрута', 'Узел боевого курса'],
  ['точка маршрута', 'узел боевого курса'],
  ['Цель роя', 'Цель группового удара'],
  ['цель роя', 'цель группового удара'],
  ['Зона запрета полётов', 'Эшелонированная зона запрета'],
  ['зона запрета полётов', 'эшелонированная зона запрета'],
  ['No-Fly Zone', 'ADIZ / Зона ПВО'],
  ['no-fly zone', 'ADIZ / Зона ПВО'],
  ['Черновик маршрута', 'Проекция маршрута'],
  ['черновик маршрута', 'проекция маршрута'],
  ['Сбросить всё', 'Отменить миссию'],
  ['сбросить всё', 'отменить миссию'],
  ['Игровой цикл', 'Боевой цикл'],
  ['игровой цикл', 'боевой цикл'],
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const rel = full.slice(ROOT.length + 1);
    if (BLACKLIST.includes(rel)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'coverage' || name.startsWith('.')) continue;
      walk(full, out);
    } else if (EXTENSIONS.includes(extname(name))) {
      out.push(rel);
    }
  }
  return out;
}

/** Перенос «шапки» регистра: DRONE->ASSET, Drone->Asset, drone->asset */
function matchCase(source, target) {
  if (source === source.toUpperCase() && /[A-Z]/.test(source)) return target.toUpperCase();
  if (source[0] === source[0]?.toUpperCase() && source.slice(1) === source.slice(1)?.toLowerCase()) {
    return target[0].toUpperCase() + target.slice(1);
  }
  return target;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function applyRules(text, rules, wordBoundary) {
  let hits = 0;
  let out = text;
  for (const [from, to] of rules) {
    const re = new RegExp(wordBoundary ? `\\b${esc(from)}\\b` : esc(from), 'g');
    out = out.replace(re, (m) => {
      hits += 1;
      return wordBoundary ? matchCase(m, to) : to;
    });
  }
  return { text: out, hits };
}

const files = [];
for (const dir of SCAN_DIRS) {
  const abs = join(ROOT, dir);
  if (existsSync(abs)) walk(abs, files);
}

const summary = [];
for (const rel of files) {
  const abs = join(ROOT, rel);
  const original = readFileSync(abs, 'utf8');
  const phrases = applyRules(original, PHRASE_MAP, false);
  const idents = applyRules(phrases.text, IDENT_MAP, true);
  const total = phrases.hits + idents.hits;
  if (total === 0) continue;
  summary.push({ file: rel, phrases: phrases.hits, idents: idents.hits });
  if (APPLY && idents.text !== original) writeFileSync(abs, idents.text, 'utf8');
}

const renamed = [];
if (APPLY) {
  for (const rel of files) {
    const base = rel.split('/').pop();
    let newBase = base;
    for (const [from, to] of IDENT_MAP) {
      newBase = newBase.replace(new RegExp(esc(from), 'gi'), (m) => matchCase(m, to));
    }
    if (newBase !== base) {
      const target = join(dirname(join(ROOT, rel)), newBase);
      if (!existsSync(target)) {
        try {
          execFileSync('git', ['mv', join(ROOT, rel), target], { stdio: 'pipe' });
        } catch {
          renameSync(join(ROOT, rel), target);
        }
        renamed.push(`${rel} -> ${newBase}`);
      }
    }
  }
}

summary.sort((a, b) => b.phrases + b.idents - (a.phrases + a.idents));
const totPhrases = summary.reduce((s, x) => s + x.phrases, 0);
const totIdents = summary.reduce((s, x) => s + x.idents, 0);
console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'}: файлов=${summary.length} фраз=${totPhrases} идентификаторов=${totIdents}`);
if (REPORT) for (const row of summary) console.log(`  ${row.file}: phrases=${row.phrases} idents=${row.idents}`);
for (const r of renamed) console.log(`  renamed: ${r}`);
