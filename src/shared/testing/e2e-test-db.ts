/**
 * Banco descartável do e2e do backend (change 05-add-backend-e2e-harness): a variável, a recusa do banco do
 * ambiente e o pulo sem a variável. A montagem do banco vem depois, no mesmo arquivo (task 1.2).
 */
export const E2E_DB_ENV = 'FLYER_PRO_E2E_DB_URL';
export const E2E_DB_URL = process.env[E2E_DB_ENV];

/** `describe` normal com a variável definida; `describe.skip` sem ela (o gate nunca abre conexão com banco). */
export function selectDescribe(url: string | undefined): typeof describe {
  return url ? describe : describe.skip;
}

export const describeIfE2eDb: typeof describe = selectDescribe(E2E_DB_URL);

/** O nome do banco como veio na URL (sem `?…`), ou `''` se a URL não traz um. */
function rawDbNameOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `${E2E_DB_ENV} não é uma URL de banco válida. Use postgres://usuario:senha@localhost:5434/chroma_x_e2e.`,
    );
  }
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

/** Nome do banco da URL em minúsculas, sem parâmetros (`?sslmode=…`). */
export function e2eDbNameOf(url: string): string {
  return rawDbNameOf(url).toLowerCase();
}

/**
 * Confere o banco ANTES de abrir qualquer conexão: o `flyer_db` é sempre recusado e só passa banco cujo nome termina
 * em `_e2e` (D-3). O erro traz o nome recebido, nunca a senha. Devolve a URL já interpretada.
 */
export function assertE2eDbUrl(url: string | undefined): URL {
  if (!url) {
    throw new Error(
      `${E2E_DB_ENV} não definida. Passe a variável só na linha do comando, apontando para um banco _e2e (veja docs/environment.md).`,
    );
  }
  const received = rawDbNameOf(url) || '(nenhum)';
  const name = received.toLowerCase();
  if (name === 'flyer_db') {
    throw new Error(
      `O e2e nunca usa o flyer_db, que é o banco do ambiente (recebido: ${received}). Aponte ${E2E_DB_ENV} para um banco _e2e.`,
    );
  }
  if (!name.endsWith('_e2e')) {
    throw new Error(
      `O e2e só usa banco cujo nome termina em _e2e (recebido: ${received}). Aponte ${E2E_DB_ENV} para um banco descartável, como chroma_x_e2e.`,
    );
  }
  return new URL(url);
}
