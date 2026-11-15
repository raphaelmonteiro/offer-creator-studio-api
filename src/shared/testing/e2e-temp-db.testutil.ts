import { Client } from 'pg';
import { assertE2eDbUrl, E2E_DB_URL } from './e2e-test-db';

export interface TempE2eDb {
  name: string;
  url: string;
  drop(): Promise<void>;
}

let counter = 0;

/** A mesma URL do banco de e2e, apontando para outro banco do mesmo Postgres. */
export function urlWithDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

/**
 * Banco `_e2e` temporário, criado e apagado pelo próprio spec no Postgres do `FLYER_PRO_E2E_DB_URL` (para cenários de
 * "banco recém-criado" sem tocar o `chroma_x_e2e`). O nome termina em `_e2e`, então passa pela recusa do harness.
 */
export async function createTempE2eDb(): Promise<TempE2eDb> {
  const base = assertE2eDbUrl(E2E_DB_URL).toString();
  counter += 1;
  const name = `chroma_x_t${process.pid}_${Date.now().toString(36)}${counter}_e2e`;
  const admin = new Client({ connectionString: urlWithDatabase(base, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  return {
    name,
    url: urlWithDatabase(base, name),
    async drop() {
      const dropper = new Client({ connectionString: urlWithDatabase(base, 'postgres') });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
