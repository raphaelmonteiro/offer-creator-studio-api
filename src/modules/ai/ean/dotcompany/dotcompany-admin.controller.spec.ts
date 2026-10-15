// O controller puxa o runner → importador de fotos → sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DotcompanyAdminController, IMPORT_FILE_MAX_BYTES } from './dotcompany-admin.controller';
import { DotcompanyBudgetService } from './dotcompany-budget.service';
import { DotcompanyLookupService } from './dotcompany-lookup.service';
import { EanImportJobService } from './ean-import-job.service';
import { EanImportRunner } from './ean-import.runner';

const JOB_ID = '0b5c7a3e-0000-4000-8000-000000000000';

async function criar(): Promise<Awaited<ReturnType<typeof montar>>['pronto']> {
  return (await montar()).pronto;
}

async function montar() {
  const relatorio = { state: 'ok', balance: { available: 2960, checkedAt: null } };
  const budget = {
    report: jest.fn().mockResolvedValue(relatorio),
    refreshBalance: jest.fn().mockResolvedValue(undefined),
  };
  const jobs = {
    criarJobDeArquivo: jest.fn().mockResolvedValue({ job: { id: JOB_ID }, created: true }),
    listar: jest.fn().mockResolvedValue([]),
    detalhe: jest.fn().mockResolvedValue({ id: JOB_ID }),
    itens: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    pausar: jest.fn().mockResolvedValue({ id: JOB_ID, status: 'paused' }),
    retomar: jest.fn().mockResolvedValue({ id: JOB_ID, status: 'pending' }),
  };
  const runner = { wake: jest.fn() };
  const lookups = {
    resolve: jest.fn().mockResolvedValue({
      outcomes: new Map([
        [
          '7891000100103',
          { ean: '7891000100103', status: 'found', cached: true, product: { nome: 'MOÇA' } },
        ],
      ]),
      credits: 0,
    }),
  };
  const mod = await Test.createTestingModule({
    controllers: [DotcompanyAdminController],
    providers: [
      { provide: DotcompanyBudgetService, useValue: budget },
      { provide: ConfigService, useValue: { get: () => 'tok' } },
      { provide: EanImportJobService, useValue: jobs },
      { provide: EanImportRunner, useValue: runner },
      { provide: DotcompanyLookupService, useValue: lookups },
    ],
  }).compile();
  return {
    mod,
    pronto: { ctrl: mod.get(DotcompanyAdminController), budget, jobs, runner, lookups, relatorio },
  };
}

const arquivo = (conteudo = 'nome;ean\nA;7891000100103\n') =>
  ({ buffer: Buffer.from(conteudo), originalname: 'arcos.csv' }) as Express.Multer.File;

describe('DotcompanyAdminController — consumo', () => {
  it('sem token administrativo → 403', async () => {
    const { ctrl } = await criar();
    await expect(ctrl.usage(undefined)).rejects.toMatchObject({ status: 403 });
    await expect(ctrl.usage('errado')).rejects.toMatchObject({ status: 403 });
  });

  it('devolve o relatório do controlador', async () => {
    const { ctrl, relatorio } = await criar();
    await expect(ctrl.usage('tok')).resolves.toBe(relatorio);
  });

  it('refresh confere o saldo antes de devolver o relatório', async () => {
    const { ctrl, budget } = await criar();
    await ctrl.refreshUsage('tok');
    expect(budget.refreshBalance).toHaveBeenCalled();
    expect(budget.report).toHaveBeenCalled();
  });
  it('refresh que falha devolve o relatório com o motivo (não 500)', async () => {
    const { ctrl, budget } = await criar();
    budget.refreshBalance.mockRejectedValueOnce(new Error('DOTCOMPANY_API_TOKEN não configurado'));
    await expect(ctrl.refreshUsage('tok')).resolves.toMatchObject({
      state: 'ok',
      refreshError: 'DOTCOMPANY_API_TOKEN não configurado',
    });
  });
});

describe('DotcompanyAdminController — jobs de importação', () => {
  it('todas as rotas exigem o token', async () => {
    const { ctrl } = await criar();
    await expect(ctrl.criarJob(undefined, arquivo())).rejects.toMatchObject({ status: 403 });
    await expect(ctrl.listarJobs(undefined)).rejects.toMatchObject({ status: 403 });
    await expect(ctrl.detalhe(undefined, JOB_ID)).rejects.toMatchObject({ status: 403 });
    await expect(ctrl.itens(undefined, JOB_ID)).rejects.toMatchObject({ status: 403 });
    await expect(ctrl.pausar(undefined, JOB_ID)).rejects.toMatchObject({ status: 403 });
    await expect(ctrl.retomar(undefined, JOB_ID)).rejects.toMatchObject({ status: 403 });
    await expect(ctrl.lookup(undefined, '7891000100103')).rejects.toMatchObject({ status: 403 });
  });

  it('cria o job, repassa cliente e teto e acorda o runner', async () => {
    const { ctrl, jobs, runner } = await criar();
    await ctrl.criarJob('tok', arquivo(), '0b5c7a3e-0000-4000-8000-000000000001', '12000');
    expect(jobs.criarJobDeArquivo).toHaveBeenCalledWith(expect.any(Buffer), {
      fileName: 'arcos.csv',
      clientId: '0b5c7a3e-0000-4000-8000-000000000001',
      costCapCredits: 12000,
    });
    expect(runner.wake).toHaveBeenCalled();
  });

  it('mesmo arquivo → mesmo job (não acorda o runner à toa)', async () => {
    const { ctrl, jobs, runner } = await criar();
    jobs.criarJobDeArquivo.mockResolvedValueOnce({ job: { id: JOB_ID }, created: false });
    const r = await ctrl.criarJob('tok', arquivo());
    expect(r).toMatchObject({ job: { id: JOB_ID }, created: false });
    expect(runner.wake).not.toHaveBeenCalled();
  });

  it('valida arquivo, cliente, teto e filtro de resultado', async () => {
    const { ctrl } = await criar();
    await expect(ctrl.criarJob('tok', undefined as never)).rejects.toMatchObject({ status: 400 });
    await expect(ctrl.criarJob('tok', arquivo(), 'nao-uuid')).rejects.toMatchObject({
      status: 400,
    });
    await expect(ctrl.criarJob('tok', arquivo(), undefined, '-5')).rejects.toMatchObject({
      status: 400,
    });
    await expect(ctrl.itens('tok', JOB_ID, 'qualquer')).rejects.toMatchObject({ status: 400 });
  });

  it('retomar troca o teto e acorda o runner', async () => {
    const { ctrl, jobs, runner } = await criar();
    await ctrl.retomar('tok', JOB_ID, '20000');
    expect(jobs.retomar).toHaveBeenCalledWith(JOB_ID, 20000);
    expect(runner.wake).toHaveBeenCalled();
  });

  it('consulta avulsa de um EAN', async () => {
    const { ctrl, lookups } = await criar();
    const r = await ctrl.lookup('tok', '7891000100103');
    expect(lookups.resolve).toHaveBeenCalledWith(['7891000100103'], { kind: 'interactive' });
    expect(r).toMatchObject({ status: 'found', cached: true, product: { nome: 'MOÇA' } });
  });
});

describe('POST /ai/dotcompany/import-jobs — token antes do upload (HTTP)', () => {
  let app: INestApplication;
  let jobs: Awaited<ReturnType<typeof criar>>['jobs'];

  beforeAll(async () => {
    const { mod, pronto } = await montar();
    jobs = pronto.jobs;
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jobs.criarJobDeArquivo.mockClear());

  const csv = () => Buffer.from('nome;ean\nA;7891000100103\n');
  const grande = () => Buffer.alloc(IMPORT_FILE_MAX_BYTES + 1024, 65);

  it('sem token → 403 e o arquivo não é processado', async () => {
    const res = await request(app.getHttpServer())
      .post('/ai/dotcompany/import-jobs')
      .attach('file', csv(), 'arcos.csv');
    expect(res.status).toBe(403);
    expect(jobs.criarJobDeArquivo).not.toHaveBeenCalled();
  });

  it('sem token e arquivo acima do limite → 403 (o guard roda antes do multer; senão seria 413)', async () => {
    // O servidor responde 403 sem ler o corpo; conforme o timing, o cliente vê a
    // resposta ou o reset da conexão. O que não pode acontecer é o 413 do multer.
    const res = await request(app.getHttpServer())
      .post('/ai/dotcompany/import-jobs')
      .attach('file', grande(), 'enorme.csv')
      .then(
        (r) => ({ status: r.status as number | undefined, code: undefined as string | undefined }),
        (e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }),
      );
    if (res.status !== undefined) expect(res.status).toBe(403);
    else expect(res.code).toMatch(/ECONNRESET|EPIPE/);
    expect(jobs.criarJobDeArquivo).not.toHaveBeenCalled();
  });

  it('token válido e arquivo acima de 20 MB → 413', async () => {
    const res = await request(app.getHttpServer())
      .post('/ai/dotcompany/import-jobs')
      .set('x-admin-token', 'tok')
      .attach('file', grande(), 'enorme.csv');
    expect(res.status).toBe(413);
    expect(jobs.criarJobDeArquivo).not.toHaveBeenCalled();
  });

  it('token válido e CSV pequeno → 201 e job criado', async () => {
    const res = await request(app.getHttpServer())
      .post('/ai/dotcompany/import-jobs')
      .set('x-admin-token', 'tok')
      .attach('file', csv(), 'arcos.csv');
    expect(res.status).toBe(201);
    expect(jobs.criarJobDeArquivo).toHaveBeenCalledTimes(1);
  });
});
