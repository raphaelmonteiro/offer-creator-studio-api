import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import type { createE2eApp as CreateE2eApp } from './e2e-app';

const fakeDataSource = { getRepository: () => ({}) } as unknown as DataSource;
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-app-job-queue-'));
afterAll(() => fs.rmSync(uploadsDir, { recursive: true, force: true }));

/** O `E2E_DB_URL` é lido na carga do módulo: cada caso carrega o harness de novo com a URL que quer. */
async function loadHarness(url: string): Promise<typeof CreateE2eApp> {
  const previous = process.env.FLYER_PRO_E2E_DB_URL;
  process.env.FLYER_PRO_E2E_DB_URL = url;
  try {
    jest.resetModules();
    return (await import('./e2e-app')).createE2eApp;
  } finally {
    if (previous === undefined) delete process.env.FLYER_PRO_E2E_DB_URL;
    else process.env.FLYER_PRO_E2E_DB_URL = previous;
  }
}

describe('App de teste do e2e com a fila do job (A-21)', () => {
  it('banco _e2e: o job liga com o provedor mock, o consumidor do worker e a conexão do pg-boss no banco de e2e', async () => {
    const create = await loadHarness(
      'postgres://usuario:s%40nha@db-e2e:5555/chroma_x_e2e?sslmode=disable',
    );
    const before = process.env.DB_DATABASE;

    const running = await create({ dataSource: fakeDataSource, uploadsDir, jobQueue: true });

    expect(running.config.get('FLYER_PRO_ENRICH_ENABLED')).toBe('true');
    expect(running.config.get('FLYER_PRO_ENRICH_PROVIDER')).toBe('mock');
    expect(running.config.get('WORKER_ONLY')).toBe('true');
    expect([
      running.config.get('DB_HOST'),
      running.config.get('DB_PORT'),
      running.config.get('DB_USERNAME'),
      running.config.get('DB_PASSWORD'),
      running.config.get('DB_DATABASE'),
    ]).toEqual(['db-e2e', '5555', 'usuario', 's@nha', 'chroma_x_e2e']);
    await running.close();
    expect(process.env.DB_DATABASE).toBe(before);
    expect(process.env.WORKER_ONLY).toBeUndefined();
  });

  it('enrichProvider real: o provedor do job é o real, as chaves seguem vazias e as flags de IA desligadas', async () => {
    const create = await loadHarness('postgres://usuario:senha@db-e2e:5555/chroma_x_e2e');
    const keysBefore = [process.env.OPENAI_API_KEY, process.env.DOTCOMPANY_API_TOKEN];
    process.env.OPENAI_API_KEY = 'sk-do-shell';
    process.env.DOTCOMPANY_API_TOKEN = 'token-do-shell';

    const running = await create({
      dataSource: fakeDataSource,
      uploadsDir,
      jobQueue: true,
      enrichProvider: 'real',
    });

    try {
      expect(running.config.get('FLYER_PRO_ENRICH_PROVIDER')).toBe('real');
      expect(process.env.OPENAI_API_KEY).toBe('');
      expect(process.env.DOTCOMPANY_API_TOKEN).toBe('');
      expect(running.config.get('AI_PRODUCT_CATEGORIZATION_ENABLED')).toBe('false');
      expect(running.config.get('AI_SPELLCHECK_ENABLED')).toBe('false');
      expect(running.config.get('AI_GALLERY_EMBEDDING_ENABLED')).toBe('false');
      expect(running.config.get('EAN_FLYER_RESOLVE_ENABLED')).toBe('false');
    } finally {
      await running.close();
      for (const [name, value] of [
        ['OPENAI_API_KEY', keysBefore[0]],
        ['DOTCOMPANY_API_TOKEN', keysBefore[1]],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('o flyer_db é recusado antes de subir qualquer coisa, e o process.env fica como estava', async () => {
    const create = await loadHarness('postgres://u:p@localhost:5434/flyer_db');

    await expect(
      create({ dataSource: fakeDataSource, uploadsDir, jobQueue: true }),
    ).rejects.toThrow(/nunca usa o flyer_db/);

    expect(process.env.DB_DATABASE).toBeUndefined();
    expect(process.env.FLYER_PRO_ENRICH_ENABLED).toBeUndefined();
  });

  it('banco que não termina em _e2e também é recusado', async () => {
    const create = await loadHarness('postgres://u:p@localhost:5434/outro_banco');

    await expect(
      create({ dataSource: fakeDataSource, uploadsDir, jobQueue: true }),
    ).rejects.toThrow(/termina em _e2e/);
  });
});
