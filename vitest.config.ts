// ═══════════════════════════════════════════════════════════════
// Vitest — юнит-тесты логики приложения (jsdom-окружение: canvas stub,
// React-рендеринг компонентов). Тестраннер НЕ входит в tsconfig include
// (src/**), поэтому не влияет на `npm run typecheck`/`npm run build`.
// ═══════════════════════════════════════════════════════════════
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // self-contained suite mission.test.ts гоняет тяжёлые A*/RRT/генетические
    // алгоритмы — нужен увеличенный таймаут (реальный прогон ~10 c).
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
