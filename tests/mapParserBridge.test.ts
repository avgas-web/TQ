// Регрессия PR#117: bridge не должен тянуть userMapLoader статически —
// цикл userMapLoader -> mapParserBridge -> userMapLoader ломал загрузчик карт.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('mapParserBridge <-> userMapLoader (циклические импорты)', () => {
  it('bridge использует только динамические импорты userMapLoader', () => {
    const src = readFileSync(new URL('../src/utils/mapParserBridge.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^import\s[^;]*from\s+['"]\.\/userMapLoader['"]/m);
    expect(src).toMatch(/await import\(['"]\.\/userMapLoader['"]\)/);
  });
});
