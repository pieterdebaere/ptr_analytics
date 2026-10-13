#!/usr/bin/env node
import path from 'node:path';
import { ConfigError, isValidEmail, loadConfig } from './config.js';
import { AuthSessionRepo } from './auth/sessions.js';
import { openDatabase } from './db/index.js';
import { ROLES, UserRepo, type Role } from './data/users.js';
import { generatePassword } from './lib/ids.js';
import { hashPassword } from './lib/password.js';

const USAGE = `PTR Analytics admin CLI

Usage:
  cli create-user <email> [admin|viewer]   create a user (default role: admin) and print a generated password
  cli reset-password <email>               generate and print a new password (signs out all sessions)
  cli list-users                           list users
  cli delete-user <email>                  delete a user (the last admin cannot be deleted)

The database location is taken from DATA_DIR (default ./data).`;

class CliError extends Error {}

export async function runCli(argv: string[], env: Record<string, string | undefined> = process.env, out: (s: string) => void = console.log): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    out(USAGE);
    return;
  }
  const config = loadConfig(env);
  const db = openDatabase(path.join(config.dataDir, 'analytics.db'));
  const users = new UserRepo(db);
  const sessions = new AuthSessionRepo(db);
  try {
    const email = (args[0] ?? '').trim().toLowerCase();
    const needEmail = (): void => {
      if (!isValidEmail(email)) throw new CliError('A valid email address is required.');
    };
    switch (command) {
      case 'create-user': {
        needEmail();
        const role = (args[1] ?? 'admin') as Role;
        if (!ROLES.includes(role)) throw new CliError('Role must be "admin" or "viewer".');
        const password = generatePassword();
        const user = users.create(email, await hashPassword(password), role, Date.now());
        if (!user) throw new CliError(`A user with email ${email} already exists.`);
        out(`Created ${role} ${user.email}`);
        out(`Password (shown only once): ${password}`);
        return;
      }
      case 'reset-password': {
        needEmail();
        const found = users.byEmailWithHash(email);
        if (!found) throw new CliError(`No user with email ${email}.`);
        const password = generatePassword();
        users.setPasswordHash(found.user.id, await hashPassword(password));
        sessions.deleteForUser(found.user.id);
        out(`New password for ${found.user.email} (shown only once): ${password}`);
        return;
      }
      case 'list-users': {
        const list = users.list();
        if (list.length === 0) out('No users.');
        for (const u of list) out(`${String(u.id).padStart(4)}  ${u.role.padEnd(6)}  ${u.email}  (created ${new Date(u.createdAt).toISOString()})`);
        return;
      }
      case 'delete-user': {
        needEmail();
        const found = users.byEmailWithHash(email);
        if (!found) throw new CliError(`No user with email ${email}.`);
        if (found.user.role === 'admin' && users.countAdmins() <= 1) throw new CliError('The last admin cannot be deleted.');
        users.delete(found.user.id);
        out(`Deleted ${found.user.email}`);
        return;
      }
      default:
        throw new CliError(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] !== undefined && /cli\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    if (err instanceof CliError || err instanceof ConfigError) console.error(err.message);
    else console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
