import type { EditResult } from './edit-cases';
import type { Labels } from './labels';
import { median, p90 } from './stats';
import { FEATHER_SWEEP } from './metrics';
import type { PromoRef } from './decision';

export interface Recommendation {
  parameter: string;
  provisional: string;
  recommended: string;
  basis: string;
}

const PENDING = 'pendente';

/** Feather: vence o menor valor com mediana de `seamSsim` a até 0,01 da melhor (varredura offline, sem rótulo). */
export function recommendFeather(edits: EditResult[]): Recommendation {
  const a = edits.filter((e) => e.block === 'A');
  const rows = FEATHER_SWEEP.map((f) => {
    const values = a
      .map((e) => e.featherSweep.find((s) => s.feather === f)?.seamSsim)
      .filter((v): v is number => typeof v === 'number');
    return { f, med: values.length ? median(values) : null };
  });
  const valid = rows.filter((r) => r.med !== null) as Array<{ f: number; med: number }>;
  if (!valid.length)
    return {
      parameter: 'feather',
      provisional: '24 px',
      recommended: PENDING,
      basis: 'sem pedidos do bloco A concluídos',
    };
  const best = Math.max(...valid.map((r) => r.med));
  const winner = valid.find((r) => r.med >= best - 0.01) as { f: number };
  const table = valid.map((r) => `${r.f} px: ${r.med.toFixed(3)}`).join('; ');
  return {
    parameter: 'feather',
    provisional: '24 px',
    recommended: `${winner.f} px`,
    basis: `mediana de seamSsim por feather (${table}); o dono rotula a costura no vencedor e em 24 px`,
  };
}

/** Margem: 8% só se `atendeu` melhorar em ≥ 2 de 5 sem custo mediano > 1,5x. */
export function recommendMargin(edits: EditResult[], labels: Labels): Recommendation {
  const m8 = edits.filter((e) => e.variant === 'm8');
  const base = m8
    .map((e) => edits.find((x) => x.key === e.key.replace(':m8', ':mask')))
    .filter(Boolean) as EditResult[];
  const at = (keys: string[]): number | null => {
    const vals = keys.map((k) => labels[k]?.edicao ?? null);
    return vals.some((v) => v === null) ? null : vals.filter((v) => v === 'atendeu').length;
  };
  const a4 = at(base.map((e) => e.key));
  const a8 = at(m8.map((e) => e.key));
  if (!m8.length || a4 === null || a8 === null)
    return {
      parameter: 'margem',
      provisional: '4%',
      recommended: PENDING,
      basis: 'faltam os rótulos dos 5 pedidos com 4% e 8%',
    };
  const cost =
    median(m8.map((e) => e.costUsd)) / Math.max(1e-9, median(base.map((e) => e.costUsd)));
  const change = a8 - a4 >= 2 && cost <= 1.5;
  return {
    parameter: 'margem',
    provisional: '4%',
    recommended: change ? '8%' : '4%',
    basis: `atendeu ${a4}/5 (4%) contra ${a8}/5 (8%); custo mediano 8%/4% = ${cost.toFixed(2)}x`,
  };
}

/** Limiar de `insideMaskDiffRatio`: o menor valor que separa os `nao_fez_nada`, com no máximo 1 `atendeu` abaixo. */
export function recommendThreshold(edits: EditResult[], labels: Labels): Recommendation {
  const a = edits.filter((e) => e.block === 'A' && e.variant === 'base');
  const lab = (e: EditResult): string | null => labels[e.key]?.edicao ?? null;
  const missing = a.filter((e) => lab(e) === null).length;
  if (!a.length || missing > 0)
    return {
      parameter: 'limiar de insideMaskDiffRatio',
      provisional: '0,02',
      recommended: PENDING,
      basis: `faltam ${missing || a.length} rótulos de edição`,
    };
  const nada = a.filter((e) => lab(e) === 'nao_fez_nada').map((e) => e.metrics.insideMaskDiffRatio);
  if (!nada.length)
    return {
      parameter: 'limiar de insideMaskDiffRatio',
      provisional: '0,02',
      recommended: '0,02 (sem separação a testar)',
      basis: 'nenhum pedido rotulado nao_fez_nada',
    };
  const t = Math.max(...nada) + 1e-6;
  const below = a.filter((e) => lab(e) === 'atendeu' && e.metrics.insideMaskDiffRatio < t).length;
  if (below > 1)
    return {
      parameter: 'limiar de insideMaskDiffRatio',
      provisional: '0,02',
      recommended: 'a métrica não serve como gatilho',
      basis: `${below} pedidos atendeu ficam abaixo de ${t.toFixed(4)}; o gatilho vira a visão (bloco E) ou um aviso`,
    };
  return {
    parameter: 'limiar de insideMaskDiffRatio',
    provisional: '0,02',
    recommended: t.toFixed(4),
    basis: `separa ${nada.length} nao_fez_nada com ${below} atendeu abaixo`,
  };
}

/** Faixa do retoque: vence a menor com borda `integrada` em ≥ 4 de 5. */
export function recommendBand(labels: Labels, promos: PromoRef[]): Recommendation {
  const bands = [16, 32, 64];
  const rows = bands.map((b) => {
    const vals = promos.map((p) => labels[`${p.id}:promo`]?.[`borda_${b}`] ?? null);
    return {
      b,
      pending: vals.some((v) => v === null),
      ok: vals.filter((v) => v === 'integrada').length,
    };
  });
  if (rows.some((r) => r.pending))
    return {
      parameter: 'faixa do retoque',
      provisional: '32 px',
      recommended: PENDING,
      basis: 'faltam rótulos de borda por faixa',
    };
  const win = rows.find((r) => r.ok >= 4);
  return {
    parameter: 'faixa do retoque',
    provisional: '32 px',
    recommended: win ? `${win.b} px` : 'nenhuma faixa atinge 4 de 5',
    basis: rows.map((r) => `${r.b} px: ${r.ok}/${promos.length} integrada`).join('; '),
  };
}

/** τ: só observação; a tolerância se calibra no estágio 4 com rótulos de ruído. */
export function observeTau(edits: EditResult[]): Recommendation {
  const hist = new Array<number>(256).fill(0);
  for (const e of edits.filter((x) => x.block === 'A'))
    e.outsideHistogram.forEach((n, i) => (hist[i] += n));
  const total = hist.reduce((a, b) => a + b, 0);
  const pct = (p: number): number => {
    let acc = 0;
    for (let i = 0; i < 256; i += 1) {
      acc += hist[i];
      if (total && acc / total >= p) return i;
    }
    return 255;
  };
  const basis = total
    ? `max|Δ| fora de A na saída bruta: p50 ${pct(0.5)}, p90 ${pct(0.9)}, p99 ${pct(0.99)} (inclui o que o modelo mudou fora da máscara)`
    : 'sem dados';
  return {
    parameter: 'τ (tolerância por pixel)',
    provisional: '16',
    recommended: '16 (manter; sem rótulo de ruído)',
    basis,
  };
}

export function summarizeBy<T>(items: T[], pick: (t: T) => number): string {
  if (!items.length) return 'n/d';
  const v = items.map(pick);
  return `mediana ${median(v).toFixed(4)}, p90 ${p90(v).toFixed(4)} (n=${v.length})`;
}
