import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin/gity.ts'],
  format: ['cjs'],
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});