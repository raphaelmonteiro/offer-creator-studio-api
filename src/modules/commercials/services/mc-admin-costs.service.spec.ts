import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  aggregateMcCosts,
  MC_COST_PROJECTS_SQL,
  MC_COSTS_SQL,
  McAdminCostsService,
  mcCostMonthRange,
  mcCurrentCostMonth,
  McCostRow,
} from './mc-admin-costs.service';

/**
 * Custo de fornecedor por mês (tarefa 8.3): SQL mockado devolvendo as linhas
 * agregadas projeto × motor × tier; o service soma e corta por projeto, motor
 * e tier, com o acumulado de vida de `mc_projects.providerCostUsd`.
 */
describe('McAdminCostsService — custo de fornecedor no mês (8.3)', () => {
  const PRO = 'fal-ai/kling-video/ai-avatar/v2/pro';
  const STD = 'fal-ai/kling-video/ai-avatar/v2/standard';
  const H3 = 'minimax/h3-max/lip-sync/image-to-video';
  const rows: McCostRow[] = [
    {
      projectId: 'p1',
      engine: PRO,
      tier: 'premium',
      clips: 3,
      costUsd: '2.7600',
      seconds: '24.000',
    },
    { projectId: 'p1', engine: H3, tier: 'premium', clips: 1, costUsd: '0.4800', seconds: '6.000' },
    { projectId: 'p2', engine: STD, tier: 'economico', clips: 2, costUsd: '0.6744', seconds: '12' },
    { projectId: 'p3', engine: 'mock', tier: 'economico', clips: 4, costUsd: '0', seconds: '20' },
  ];
  const projects = [
    {
      id: 'p1',
      title: 'Ofertas premium',
      userId: 'u1',
      format: 'talking_art',
      tier: 'premium',
      status: 'succeeded',
      providerCostUsd: '5.2000',
    },
    {
      id: 'p2',
      title: 'Ofertas',
      userId: 'u2',
      format: 'talking_art',
      tier: 'economico',
      status: 'succeeded',
      providerCostUsd: '0.6744',
    },
  ];

  it('intervalo do mês em UTC; mês inválido → 400 INVALID_MONTH; mês corrente por padrão', () => {
    expect(mcCostMonthRange('2026-10')).toEqual({
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(mcCostMonthRange('2026-12').to).toEqual(new Date('2027-01-01T00:00:00.000Z'));
    expect(() => mcCostMonthRange('2026-13')).toThrow(BadRequestException);
    expect(() => mcCostMonthRange('10/2026')).toThrow(BadRequestException);
    expect(mcCurrentCostMonth(new Date('2026-10-12T12:00:00Z'))).toBe('2026-10');
    expect(mcCurrentCostMonth(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01');
  });

  it('aggregateMcCosts: totais, por projeto (com motores e acumulado de vida), por motor e por tier, ordenados por custo', () => {
    const range = mcCostMonthRange('2026-10');
    const report = aggregateMcCosts('2026-10', range, rows, projects);
    expect(report.month).toBe('2026-10');
    expect(report.currency).toBe('USD');
    expect(report.range).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });
    expect(report.totals).toEqual({ providerCostUsd: 3.9144, clips: 10, seconds: 62, projects: 3 });
    expect(report.byProject.map((p) => p.projectId)).toEqual(['p1', 'p2', 'p3']);
    expect(report.byProject[0]).toMatchObject({
      projectId: 'p1',
      title: 'Ofertas premium',
      userId: 'u1',
      tier: 'premium',
      providerCostUsd: 3.24,
      clips: 4,
      seconds: 30,
      projectProviderCostUsd: 5.2,
      byEngine: [
        { engine: PRO, providerCostUsd: 2.76, clips: 3, seconds: 24 },
        { engine: H3, providerCostUsd: 0.48, clips: 1, seconds: 6 },
      ],
    });
    // projeto sem linha em mc_projects: dados nulos, custo do mês preservado
    expect(report.byProject[2]).toMatchObject({
      projectId: 'p3',
      title: null,
      projectProviderCostUsd: null,
      providerCostUsd: 0,
      clips: 4,
    });
    expect(report.byEngine).toEqual([
      { engine: PRO, providerCostUsd: 2.76, clips: 3, seconds: 24 },
      { engine: STD, providerCostUsd: 0.6744, clips: 2, seconds: 12 },
      { engine: H3, providerCostUsd: 0.48, clips: 1, seconds: 6 },
      { engine: 'mock', providerCostUsd: 0, clips: 4, seconds: 20 },
    ]);
    expect(report.byTier).toEqual([
      { tier: 'premium', providerCostUsd: 3.24, clips: 4, seconds: 30 },
      { tier: 'economico', providerCostUsd: 0.6744, clips: 6, seconds: 32 },
    ]);
  });

  it('monthlyCosts: consulta os clipes do intervalo e os projetos citados (query mockada)', async () => {
    const query = jest.fn((sql: string) =>
      Promise.resolve(sql === MC_COSTS_SQL ? rows : sql === MC_COST_PROJECTS_SQL ? projects : []),
    );
    const service = new McAdminCostsService({ query } as unknown as DataSource);
    const report = await service.monthlyCosts('2026-10');
    expect(query).toHaveBeenNthCalledWith(1, MC_COSTS_SQL, [
      new Date('2026-10-01T00:00:00.000Z'),
      new Date('2026-11-01T00:00:00.000Z'),
    ]);
    expect(query).toHaveBeenNthCalledWith(2, MC_COST_PROJECTS_SQL, [['p1', 'p2', 'p3']]);
    expect(report.totals.providerCostUsd).toBe(3.9144);
    // o SQL lê custo/motor/tier do metadata do clipe e só os kinds de clipe
    expect(MC_COSTS_SQL).toContain("a.metadata->>'providerCostUsd'");
    expect(MC_COSTS_SQL).toContain("a.metadata->'engine'->>'model'");
    expect(MC_COSTS_SQL).toContain("('scene_synced', 'scene_clip')");
    // segundos: os COBRADOS (talk com silêncio do submit: max(clipe cru, áudio enviado)),
    // depois os do clipe cru, depois a duração do arquivo
    expect(MC_COSTS_SQL).toContain(
      "COALESCE((a.metadata->>'billedDurationMs')::numeric, (a.metadata->'conform'->>'rawDurationMs')::numeric, a.\"durationMs\")",
    );
  });

  it('mês sem clipes: relatório zerado sem consultar projetos', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new McAdminCostsService({ query } as unknown as DataSource);
    const report = await service.monthlyCosts('2026-01');
    expect(query).toHaveBeenCalledTimes(1);
    expect(report.totals).toEqual({ providerCostUsd: 0, clips: 0, seconds: 0, projects: 0 });
    expect(report.byProject).toEqual([]);
  });

  it('mês inválido não chega ao banco', async () => {
    const query = jest.fn();
    const service = new McAdminCostsService({ query } as unknown as DataSource);
    await expect(service.monthlyCosts('2026-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
});
