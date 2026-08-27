import { randomUUID } from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { users, type Role, type User } from '../db/schema.js';
import { hashPassword, verifyPassword } from './password.js';

export async function findByUsername(db: Db, username: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(users.username, username.toLowerCase()) });
}

export async function createUser(
  db: Db,
  input: { username: string; password: string; role?: Role },
): Promise<User> {
  const id = randomUUID();
  const passwordHash = await hashPassword(input.password);
  await db.insert(users).values({
    id,
    username: input.username.toLowerCase(),
    passwordHash,
    role: input.role ?? 'operator',
  });
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!user) throw new Error('failed to read back created user');
  return user;
}

export async function updateUser(
  db: Db,
  userId: string,
  patch: { role?: Role; disabled?: boolean },
): Promise<User | undefined> {
  await db
    .update(users)
    .set({ ...patch, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(users.id, userId));
  return db.query.users.findFirst({ where: eq(users.id, userId) });
}

export async function listUsers(db: Db): Promise<User[]> {
  return db.query.users.findMany({ orderBy: (u, { asc }) => [asc(u.username)] });
}

export async function deleteUser(db: Db, userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

/** Count enabled admins — used to block removing/demoting/disabling the last one. */
export async function activeAdminCount(db: Db): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.disabled, false)));
  return rows[0]?.value ?? 0;
}

export async function setPassword(db: Db, userId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(users.id, userId));
}

export async function authenticate(db: Db, username: string, password: string): Promise<User | null> {
  const user = await findByUsername(db, username);
  if (!user || user.disabled) {
    // constant-ish time: still run a hash verify against a dummy
    await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000', password);
    return null;
  }
  const ok = await verifyPassword(user.passwordHash, password);
  return ok ? user : null;
}

/** Create the first admin from env if the users table is empty. */
export async function bootstrapAdmin(
  db: Db,
  log: Logger,
  creds: { username?: string; password?: string },
): Promise<void> {
  const rows = await db.select({ value: count() }).from(users);
  if ((rows[0]?.value ?? 0) > 0) return;

  if (!creds.username || !creds.password) {
    log.warn(
      'No users exist and ADMIN_USER / ADMIN_PASSWORD are not set. ' +
        'Set them (or CLI --admin-user/--admin-password) and restart to create the first admin.',
    );
    return;
  }
  await createUser(db, { username: creds.username, password: creds.password, role: 'admin' });
  log.warn(
    { username: creds.username.toLowerCase() },
    'Created initial admin user from env. Change this password after first login.',
  );
}
