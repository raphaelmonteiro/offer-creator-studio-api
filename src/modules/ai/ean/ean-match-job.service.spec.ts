import { EanMatchJobService } from './ean-match-job.service';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { comoBuffer, LINHAS_LIMPAS } from './ean-test-fixtures';
import { SpreadsheetEanMatchService } from './spreadsheet-ean-match.service';

function criarServico() {
  const inseridos: Array<Record<string, unknown>> = [];
  const jobs: Array<Record<string, unknown>> = [];
  const manager = {
    create: (_: unknown, data: Record<string, unknown>) => data,
    save: jest.fn(async (data: Record<string, unknown>) => {
      const job = { ...data, id: 'job-1' };
      jobs.push(job);
      return job;
    }),
    insert: jest.fn(async (entity: unknown, rows: Array<Record<string, unknown>>) => {
      expect(entity).toBe(EanMatchItem);
      inseridos.push(...rows);
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: typeof manager) => Promise<string>) => fn(manager)),
    query: jest.fn(),
  };
  const config = { get: (_: string, def: string) => def };
  const planilha = new SpreadsheetEanMatchService({} as never, {} as never);
  const service = new EanMatchJobService(dataSource as never, planilha, config as never);
  return { service, inseridos, jobs, dataSource };
}

describe('EanMatchJobService.criarJob', () => {
  it('cria um item por linha com EAN válido e conta as descartadas', async () => {
    const { service, inseridos, jobs } = criarServico();
    const r = await service.criarJob(comoBuffer(LINHAS_LIMPAS), { fileName: 'flv.xlsx' });

    expect(r.jobId).toBe('job-1');
    expect(r.itens).toBe(7);
    expect(r.descartadas).toBe(3);
    expect(inseridos).toHaveLength(7);
    expect(inseridos.every((i) => i.status === 'pending' && i.jobId === 'job-1')).toBe(true);
    expect(jobs[0]).toMatchObject({ status: 'running', totalRows: 7, discardedRows: 3 });
  });

  it('guarda o hash do arquivo e o EAN normalizado', async () => {
    const { service, inseridos, jobs } = criarServico();
    await service.criarJob(comoBuffer(LINHAS_LIMPAS));

    expect(jobs[0].fileHash).toMatch(/^[0-9a-f]{64}$/);
    const tomate = inseridos.find((i) => String(i.description).includes('TOMATE GRAPE'));
    expect(tomate?.ean).toBe('07898949912088');
  });

  it('não processa nada na ingestão (nenhuma query além da transação)', async () => {
    const { service, dataSource } = criarServico();
    await service.criarJob(comoBuffer(LINHAS_LIMPAS));
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('usa o teto de custo informado', async () => {
    const { service, jobs } = criarServico();
    await service.criarJob(comoBuffer(LINHAS_LIMPAS), { costCapUsd: 12.5 });
    expect(jobs[0].costCapUsd).toBe('12.5000');
  });
});
