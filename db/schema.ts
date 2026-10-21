import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Authentication bindings stay inside this server-only payload. The API returns
// only an explicitly scoped business snapshot, never the complete payload.
export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  payload: text('payload').notNull(),
  revision: integer('revision').notNull().default(1),
});
