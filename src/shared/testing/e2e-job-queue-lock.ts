import type { DataSource, QueryRunner } from 'typeorm';

/**
 * A trava de sessão que serializa os specs com a fila real: dois apps com `jobQueue` consomem a mesma fila (`pgboss`, a
 * mesma do banco de e2e) e um lote pode ser assumido pelo app do outro spec, que talvez rode outro provedor do job. A
 * trava vale da subida do app ao fim do spec, em outra chave que a da montagem do banco.
 */
const JOB_QUEUE_LOCK_KEY = 7_770_002;

/**
 * O prazo para esperar a vez (PV-9): a suíte que segura a trava leva de 1 a 2 min e, sob carga, bem mais. O `beforeAll`
 * do harness soma este prazo ao da subida do app, para o prazo do Jest nunca vir antes do daqui.
 */
export const JOB_QUEUE_LOCK_WAIT_MS = 10 * 60_000;

const JOB_QUEUE_LOCK_POLL_MS = 500;

export interface JobQueueLockWait {
  timeoutMs: number;
  pollMs: number;
}

/** Tenta a trava em laço (nunca fica uma consulta pendente na conexão) até o prazo. */
async function waitForTurn(runner: QueryRunner, wait: JobQueueLockWait): Promise<void> {
  const deadline = Date.now() + wait.timeoutMs;
  for (;;) {
    const [row] = await runner.query('SELECT pg_try_advisory_lock($1) AS locked', [
      JOB_QUEUE_LOCK_KEY,
    ]);
    if (row.locked) return;
    if (Date.now() >= deadline) {
      throw new Error(`Trava da fila de e2e ocupada por mais de ${wait.timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, wait.pollMs));
  }
}

/**
 * Espera a vez da fila e a segura numa conexão só (a trava de sessão morre com a conexão). Devolve a função que a solta.
 * Em qualquer caminho a conexão volta ao pool: no prazo estourado ou numa falha, aqui mesmo antes de lançar; no
 * sucesso, quando a função devolvida roda.
 */
export async function holdJobQueueLock(
  dataSource: DataSource,
  wait: JobQueueLockWait = { timeoutMs: JOB_QUEUE_LOCK_WAIT_MS, pollMs: JOB_QUEUE_LOCK_POLL_MS },
): Promise<() => Promise<void>> {
  const runner = dataSource.createQueryRunner();
  try {
    await runner.connect();
    await waitForTurn(runner, wait);
  } catch (error) {
    await runner.release();
    throw error;
  }
  return async () => {
    try {
      await runner.query('SELECT pg_advisory_unlock($1)', [JOB_QUEUE_LOCK_KEY]);
    } catch {
      // a conexão que cair já soltou a trava (é de sessão); o que importa é devolvê-la ao pool
    } finally {
      await runner.release();
    }
  };
}
