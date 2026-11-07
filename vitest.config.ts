import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  },
});
