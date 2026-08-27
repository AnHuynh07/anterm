import { defineConfig } from 'drizzle-kit';

// Used only for authoring new migrations (`npm run db:generate`).
// Runtime migrations are applied by src/db/migrate.ts on boot.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
