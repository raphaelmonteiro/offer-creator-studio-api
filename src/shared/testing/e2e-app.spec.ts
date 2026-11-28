import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import {
  BOOT_FLAGS,
  createE2eApp,
  E2E_JWT_SECRET,
  E2eApp,
  overrideEnv,
  PAID_KEYS,
} from './e2e-app';
import { expectUploadsStaticResponse, fetchUploadsFile } from './uploads-static.testutil';

/** Sem banco: o DataSource é um dublê que só entrega repositórios vazios (nenhuma rota é chamada aqui). */
const fakeDataSource = { getRepository: () => ({}) } as unknown as DataSource;
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-app-spec-'));

describe('App de teste do e2e: nenhuma chamada paga', () => {
  let running: E2eApp | undefined;
  const restoreShell: Array<() => void> = [];

  const boot = async () => {
    running = await createE2eApp({ dataSource: fakeDataSource, uploadsDir });
    return running;
  };

  afterEach(async () => {
    await running?.close();
    running = undefined;
    restoreShell.splice(0).forEach((restore) => restore());
  });
  afterAll(() => fs.rmSync(uploadsDir, { recursive: true, force: true }));

  it('chave paga no ambiente do shell: vazia no process.env e no ConfigService, e volta no fim', async () => {
    restoreShell.push(
      overrideEnv({ OPENAI_API_KEY: 'sk-do-shell', AI_SPELLCHECK_ENABLED: 'true' }),
    );
    const { config, close } = await boot();
    expect(process.env.OPENAI_API_KEY).toBe('');
    expect(config.get('OPENAI_API_KEY')).toBe('');
    expect(process.env.AI_SPELLCHECK_ENABLED).toBe('false');
    expect(config.get('AI_SPELLCHECK_ENABLED')).toBe('false');
    await close();
    running = undefined;
    expect(process.env.OPENAI_API_KEY).toBe('sk-do-shell');
    expect(process.env.AI_SPELLCHECK_ENABLED).toBe('true');
  });

  it('zera as dez chaves pagas e desliga as nove flags de boot; o process.env volta ao que era antes', async () => {
    const watched = PAID_KEYS.concat(BOOT_FLAGS);
    const before = watched.map((key) => process.env[key]);
    const { config, close } = await boot();
    for (const key of PAID_KEYS) expect(config.get(key)).toBe('');
    for (const flag of BOOT_FLAGS) expect(config.get(flag)).toBe('false');
    expect(PAID_KEYS).toHaveLength(10);
    expect(PAID_KEYS).toContain('SERPER_API_KEY');
    expect(BOOT_FLAGS).toHaveLength(9);
    await close();
    running = undefined;
    expect(watched.map((key) => process.env[key])).toEqual(before);
  });

  it('por padrão nenhuma fila sobe: as três flags da fila desligadas e nenhum consumidor do worker', async () => {
    const { config } = await boot();
    for (const flag of [
      'ANIMATIONS_ENABLED',
      'TEMPLATE_SCENE_ENABLED',
      'FLYER_PRO_ENRICH_ENABLED',
    ]) {
      expect(config.get(flag)).toBe('false');
    }
    expect(config.get('WORKER_ONLY')).toBeUndefined();
  });

  it('chave no backend/.env: o ConfigService não devolve o valor do arquivo', async () => {
    const cwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-app-dotenv-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      'OPENAI_API_KEY=sk-do-arquivo\nJWT_SECRET=segredo-do-arquivo\nSO_NO_ARQUIVO=sim\n',
    );
    process.chdir(dir);
    try {
      const { config } = await boot();
      expect(config.get('OPENAI_API_KEY')).toBe('');
      expect(config.get('JWT_SECRET')).toBe(E2E_JWT_SECRET);
      expect(config.get('SO_NO_ARQUIVO')).toBeUndefined();
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** O estático de `/uploads/` do `main.ts` no app de teste (change 34, D-1 (a)): só quando o spec pede. */
describe('App de teste do e2e: estático de uploads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-app-static-'));
  const bytes = Buffer.from([0, 1, 0, 0, 4, 5, 6]);
  let running: E2eApp | undefined;

  beforeAll(() => {
    // O filtro de erros escreve `console.error` fora de produção; o 404 do caso negativo é esperado.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fs.mkdirSync(path.join(dir, 'fonts'));
    fs.writeFileSync(path.join(dir, 'fonts', 'teste.ttf'), bytes);
  });
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });
  afterAll(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const bootAndGetFont = async (serveUploads?: boolean) => {
    running = await createE2eApp({ dataSource: fakeDataSource, uploadsDir: dir, serveUploads });
    return fetchUploadsFile(running.app.getHttpServer(), '/uploads/fonts/teste.ttf');
  };

  it('com o estático pedido: 200, os bytes do arquivo e os três cabeçalhos, sem token', async () => {
    const response = await bootAndGetFont(true);
    expectUploadsStaticResponse(response, bytes);
  });

  it('sem o estático pedido: 404, e o arquivo não é servido (negativo)', async () => {
    const response = await bootAndGetFont();
    expect(response.status).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
