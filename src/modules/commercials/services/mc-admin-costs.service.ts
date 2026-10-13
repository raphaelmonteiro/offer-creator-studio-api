import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MC_COST_MONTH_PATTERN } from '../dto/admin-costs.dto';

/**
 * Relatório de custo de FORNECEDOR dos comerciais por mês (tarefa 8.3,
 * `GET /commercials/admin/costs`): por projeto, por motor e por tier, a
 * partir do custo gravado em cada clipe pelo ingest
 * (`animation_assets.metadata.providerCostUsd` + `engine`/`tier`) — a mesma
 * telemetria que soma em `mc_projects.providerCostUsd`, que vai junto por
 * projeto como acumulado de vida. O mês é o da CRIAÇÃO do clipe (quando o
 * custo aconteceu), em UTC. Só leitura; nada aqui decide cobrança.
 */

/** Linha agregada do SQL (projeto × motor × tier) — números chegam como texto do pg. */
export interface McCostRow {
  projectId: string | null;
  engine: string;
  tier: string;
  clips: number | string;
  costUsd: number | string;
  seconds: number | string | null;
}

/** Projeto citado no mês (dados de `mc_projects`). */
export interface McCostProjectRow {
  id: string;
  title: string | null;
  userId: string | null;
  format: string | null;
  tier: string | null;
  status: string | null;
  providerCostUsd: number | string | null;
}

export interface McCostBucket {
  providerCostUsd: number;
  clips: number;
  seconds: number;
}

export interface McCostReport {
  month: string;
  range: { from: string; to: string };
  currency: 'USD';
  totals: McCostBucket & { projects: number };
  byProject: Array<
    McCostBucket & {
      projectId: string | null;
      title: string | null;
      userId: string | null;
      format: string | null;
      tier: string | null;
      status: string | null;
      /** Acumulado de vida do projeto (`mc_projects.providerCostUsd`), não só do mês. */
      projectProviderCostUsd: number | null;
      byEngine: Array<McCostBucket & { engine: string }>;
    }
  >;
  byEngine: Array<McCostBucket & { engine: string }>;
  byTier: Array<McCostBucket & { tier: string }>;
}

const round4 = (n: number) => Number(n.toFixed(4));
const round2 = (n: number) => Number(n.toFixed(2));
const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** `YYYY-MM` → intervalo UTC [início do mês, início do mês seguinte). */
export function mcCostMonthRange(month: string): { from: Date; to: Date } {
  if (!MC_COST_MONTH_PATTERN.test(month)) {
    throw new BadRequestException({
      code: 'INVALID_MONTH',
      message: 'month deve estar no formato YYYY-MM.',
    });
  }
  const [year, mon] = month.split('-').map(Number);
  return { from: new Date(Date.UTC(year, mon - 1, 1)), to: new Date(Date.UTC(year, mon, 1)) };
}

/** Mês corrente em UTC (`YYYY-MM`). */
export function mcCurrentCostMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function addTo(bucket: McCostBucket, row: { cost: number; clips: number; seconds: number }) {
  bucket.providerCostUsd += row.cost;
  bucket.clips += row.clips;
  bucket.seconds += row.seconds;
}

function finish<T extends McCostBucket>(bucket: T): T {
  return {
    ...bucket,
    providerCostUsd: round4(bucket.providerCostUsd),
    seconds: round2(bucket.seconds),
  };
}

const byCostDesc = (a: McCostBucket, b: McCostBucket) => b.providerCostUsd - a.providerCostUsd;

/** Agregação PURA das linhas (projeto × motor × tier) em totais e cortes por projeto/motor/tier. */
export function aggregateMcCosts(
  month: string,
  range: { from: Date; to: Date },
  rows: McCostRow[],
  projects: McCostProjectRow[],
): McCostReport {
  const empty = (): McCostBucket => ({ providerCostUsd: 0, clips: 0, seconds: 0 });
  const totals = empty();
  const engines = new Map<string, McCostBucket>();
  const tiers = new Map<string, McCostBucket>();
  const perProject = new Map<
    string,
    { bucket: McCostBucket; engines: Map<string, McCostBucket> }
  >();
  for (const row of rows) {
    const values = { cost: num(row.costUsd), clips: num(row.clips), seconds: num(row.seconds) };
    addTo(totals, values);
    const engine = row.engine || 'unknown';
    const tier = row.tier || 'economico';
    if (!engines.has(engine)) engines.set(engine, empty());
    addTo(engines.get(engine)!, values);
    if (!tiers.has(tier)) tiers.set(tier, empty());
    addTo(tiers.get(tier)!, values);
    const key = row.projectId ?? '';
    if (!perProject.has(key)) perProject.set(key, { bucket: empty(), engines: new Map() });
    const project = perProject.get(key)!;
    addTo(project.bucket, values);
    if (!project.engines.has(engine)) project.engines.set(engine, empty());
    addTo(project.engines.get(engine)!, values);
  }
  const info = new Map(projects.map((p) => [p.id, p]));
  const byProject = [...perProject.entries()]
    .map(([projectId, { bucket, engines: projectEngines }]) => {
      const p = projectId ? info.get(projectId) : undefined;
      return {
        ...finish(bucket),
        projectId: projectId || null,
        title: p?.title ?? null,
        userId: p?.userId ?? null,
        format: p?.format ?? null,
        tier: p?.tier ?? null,
        status: p?.status ?? null,
        projectProviderCostUsd: p ? round4(num(p.providerCostUsd)) : null,
        byEngine: [...projectEngines.entries()]
          .map(([engine, b]) => ({ engine, ...finish(b) }))
          .sort(byCostDesc),
      };
    })
    .sort(byCostDesc);
  return {
    month,
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    currency: 'USD',
    totals: { ...finish(totals), projects: byProject.filter((p) => p.projectId).length },
    byProject,
    byEngine: [...engines.entries()]
      .map(([engine, b]) => ({ engine, ...finish(b) }))
      .sort(byCostDesc),
    byTier: [...tiers.entries()].map(([tier, b]) => ({ tier, ...finish(b) })).sort(byCostDesc),
  };
}

/**
 * Clipes com custo de fornecedor (`scene_synced`/`scene_clip` com
 * `providerCostUsd` gravado) criados no mês, agrupados por projeto × motor ×
 * tier. Motor: `engine.model` (talk) → `provider` (lipsync/ação legados);
 * tier: o gravado no clipe (talk) → o do projeto → econômico. Segundos: os
 * COBRADOS (`billedDurationMs`, gravado pelo ingest do talk: clipe cru, nunca
 * abaixo do áudio enviado com silêncio até o mínimo do motor — H3: 5 s), senão
 * os do clipe CRU do fornecedor quando conformado (base da tarifa), senão a
 * duração do arquivo. Soft-deletados contam (o custo aconteceu).
 */
export const MC_COSTS_SQL = `
SELECT a.metadata->>'projectId' AS "projectId",
       COALESCE(NULLIF(a.metadata->'engine'->>'model', ''), NULLIF(a.metadata->>'provider', ''), 'unknown') AS engine,
       COALESCE(NULLIF(a.metadata->>'tier', ''), p.tier, 'economico') AS tier,
       COUNT(*)::int AS clips,
       COALESCE(SUM((a.metadata->>'providerCostUsd')::numeric), 0)::text AS "costUsd",
       (COALESCE(SUM(COALESCE((a.metadata->>'billedDurationMs')::numeric, (a.metadata->'conform'->>'rawDurationMs')::numeric, a."durationMs")), 0) / 1000)::text AS seconds
  FROM animation_assets a
  LEFT JOIN mc_projects p ON p.id::text = a.metadata->>'projectId'
 WHERE a.kind IN ('scene_synced', 'scene_clip')
   AND a.metadata->>'providerCostUsd' IS NOT NULL
   AND a."createdAt" >= $1
   AND a."createdAt" < $2
 GROUP BY 1, 2, 3`;

export const MC_COST_PROJECTS_SQL = `
SELECT id::text AS id, title, "userId"::text AS "userId", format, tier, status,
       "providerCostUsd"::text AS "providerCostUsd"
  FROM mc_projects
 WHERE id::text = ANY($1::text[])`;

@Injectable()
export class McAdminCostsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async monthlyCosts(month: string = mcCurrentCostMonth()): Promise<McCostReport> {
    const range = mcCostMonthRange(month);
    const rows = (await this.dataSource.query(MC_COSTS_SQL, [range.from, range.to])) as McCostRow[];
    const projectIds = [
      ...new Set(rows.map((r) => r.projectId).filter((id): id is string => !!id)),
    ];
    const projects = projectIds.length
      ? ((await this.dataSource.query(MC_COST_PROJECTS_SQL, [projectIds])) as McCostProjectRow[])
      : [];
    return aggregateMcCosts(month, range, rows, projects);
  }
}
