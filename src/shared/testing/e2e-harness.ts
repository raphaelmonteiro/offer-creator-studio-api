import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { createE2eApp, E2eApp, E2eAppOptions, overrideEnv } from './e2e-app';
import { holdJobQueueLock, JOB_QUEUE_LOCK_WAIT_MS } from './e2e-job-queue-lock';
import { applyE2eSeed, E2eSeed } from './e2e-seed';
import { openE2eDb } from './e2e-test-db';

/** Níveis do `Logger` do Nest antes de o harness o silenciar. */
const DEFAULT_LOG_LEVELS = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;

/** O prazo da subida do app e da semente; com a fila real soma-se o da espera pela trava. */
const BOOT_TIMEOUT_MS = 240_000;

type E2eHarnessOptions = Pick<
  E2eAppOptions,
  'imports' | 'controllers' | 'providers' | 'jobQueue' | 'enrichProvider'
>;

export interface E2eHarnessState {
  dataSource: DataSource;
  app: E2eApp;
  seed: E2eSeed;
  uploadsDir: string;
  token: string;
}

type Called = (req: request.Test) => request.Test;

/**
 * Preparo comum dos specs de e2e do backend. Chame dentro do `describeIfE2eDb`, no corpo do `describe`. No `beforeAll`:
 * abre e monta o banco, sobe o app (guard, pipe, filtro e interceptor reais) com o que o spec pede, aplica a semente
 * e assina o token do usuário dela. No `afterAll`: limpa a semente, fecha o app e o banco, apaga a pasta temporária e
 * restaura o `process.env` e o log. Silencia os logs só durante a suíte.
 *
 * Os dados que o spec criar pelas rotas e que a semente não conhece entram em `h.onCleanup(fn)`: a função roda antes
 * da limpeza da semente.
 */
export function useE2eHarness(appOptions: E2eHarnessOptions = {}) {
  jest.setTimeout(60_000);
  const h = {} as E2eHarnessState;
  const cleanups: Array<() => Promise<unknown>> = [];
  let restoreEnv: (() => void) | undefined;
  let releaseQueueLock: (() => Promise<void>) | undefined;

  const bootTimeout = BOOT_TIMEOUT_MS + (appOptions.jobQueue ? JOB_QUEUE_LOCK_WAIT_MS : 0);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    restoreEnv = overrideEnv({ NODE_ENV: 'production' }); // o filtro de erros não escreve console.error por teste
    h.dataSource = await openE2eDb();
    if (appOptions.jobQueue) releaseQueueLock = await holdJobQueueLock(h.dataSource);
    h.uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyer-pro-e2e-'));
    h.app = await createE2eApp({
      ...appOptions,
      dataSource: h.dataSource,
      uploadsDir: h.uploadsDir,
    });
    h.seed = await applyE2eSeed(h.dataSource, { uploadsDir: h.uploadsDir });
    h.token = h.app.jwt.sign({ sub: h.seed.user.id, email: h.seed.user.email });
  }, bootTimeout);

  afterAll(async () => {
    try {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      await h.seed?.cleanup();
    } finally {
      await h.app?.close();
      await releaseQueueLock?.();
      await h.dataSource?.destroy();
      if (h.uploadsDir) await fs.rm(h.uploadsDir, { recursive: true, force: true });
      restoreEnv?.();
      Logger.overrideLogger([...DEFAULT_LOG_LEVELS]);
    }
  });

  const http = () => request(h.app.app.getHttpServer());
  const authed: Called = (req) => req.set('Authorization', `Bearer ${h.token}`);

  return Object.assign(h, {
    http,
    authed,
    /** Rotas autenticadas com o token da semente; `url` sem o prefixo `/v1`. */
    get: (url: string) => authed(http().get(`/v1${url}`)),
    post: (url: string, body?: object) => authed(http().post(`/v1${url}`)).send(body),
    patch: (url: string, body?: object) => authed(http().patch(`/v1${url}`)).send(body),
    delete: (url: string) => authed(http().delete(`/v1${url}`)),
    onCleanup: (cleanup: () => Promise<unknown>) => cleanups.push(cleanup),
  });
}
