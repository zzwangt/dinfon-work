import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The API returns only scoped business snapshots. Password hashes and sessions
// live in separate server-only tables and never enter a business export.
export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  payload: text('payload').notNull(),
  revision: integer('revision').notNull().default(1),
});

export const authCredentials = sqliteTable('auth_credentials', {
  accountId: text('account_id').primaryKey(),
  login: text('login').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  mustChange: integer('must_change').notNull().default(1),
  version: integer('version').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
});

export const authSessions = sqliteTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  accountId: text('account_id').notNull(),
  credentialVersion: integer('credential_version').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [index('auth_sessions_account').on(table.accountId), index('auth_sessions_expiry').on(table.expiresAt)]);

export const authRateLimits = sqliteTable('auth_rate_limits', {
  bucket: text('bucket').primaryKey(),
  attempts: integer('attempts').notNull(),
  windowEnd: integer('window_end').notNull(),
});
