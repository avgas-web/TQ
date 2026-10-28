import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/utils/userMapLoader.ts',
        'src/utils/userMapGeo.ts',
        'src/utils/userMapRender.ts',
        'src/utils/openStreetMap.ts',
        'src/utils/storage.ts',
      ],
      reporter: ['text', 'lcov'],
    },
  },
});
