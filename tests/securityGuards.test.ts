// ═══════════════════════════════════════════════════════════════
// ФАЗА 5.3 (CI/Security guard): регрессионный тест-страховка.
//
// Аудит (ФАЗА 2) устранил XSS: попапы OSM/Overpass и WizardMapPanel
// больше не инъецируют внешние данные в DOM через
// dangerouslySetInnerHTML. Единственный легальный путь HTML-разметки —
// модуль buildingLookup, который возвращает *текстовые* поля без тегов.
//
// Этот тест сканирует весь src/** на наличие новых употреблений
// dangerouslySetInnerHTML и innerHTML с интерполяцией, чтобы любая
// будущая регрессия (или новый код) падала в CI, а не в проде.
// ═══════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("security guards (Phase 5 CI)", () => {
  const files = walk(SRC);

  it("в src/ нет ни одного dangerouslySetInnerHTML", () => {
    const offenders = files
      .map((f) => ({ f, c: readFileSync(f, "utf8") }))
      .filter(({ c }) => /dangerouslySetInnerHTML\s*[=:]/.test(c)) // комментарии/упоминания не считаются
      .map(({ f }) => f.replace(SRC, "src"));
    expect(offenders).toEqual([]);
  });

  it("нет присваиваний .innerHTML с шаблонными строками (сырые данные → DOM)", () => {
    const offenders = files
      .map((f) => ({ f, c: readFileSync(f, "utf8") }))
      .filter(({ c }) => /\.innerHTML\s*=\s*`/.test(c))
      .map(({ f }) => f.replace(SRC, "src"));
    expect(offenders).toEqual([]);
  });

  it("package.json содержит typecheck/lint/test скрипты для CI", () => {
    const pkgPath = join(
      fileURLToPath(import.meta.url),
      "..",
      "..",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const s of ["typecheck", "lint", "test", "build"]) {
      expect(pkg.scripts[s], `script "${s}"`).toBeTruthy();
    }
  });
});
