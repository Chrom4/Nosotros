import type { Config } from 'drizzle-kit';

export default {
  schema: ['./src/data/schema/domain.ts', './src/data/schema/sync.ts'],
  out: './src/data/migrations',
  dialect: 'sqlite',
  driver: 'expo',
} satisfies Config;
