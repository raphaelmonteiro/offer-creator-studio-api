import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BACKEND_DIR } from './config';
import type { Prices, SpikeConfig } from './config';
import { collect } from './collect';
import type { Collected } from './collect';
import {
  recommendBand,
  recommendFeather,
  recommendMargin,
  recommendThreshold,
  observeTau,
  summarizeBy,
} from './calibrate';
import type { Recommendation } from './calibrate';
import { decideA, decideB, decideC } from './decision';
import type { BlockDecision } from './decision';
import type { EditResult } from './edit-cases';
import { ensureLabels } from './labels';
import type { Labels } from './labels';
import { summarize } from './stats';
import type { CasesFile } from './types';

const fmt = (n: number | null | undefined, d = 3): string => (n == null ? '—' : n.toFixed(d));
const rel = (dir: string, file: string): string => path.relative(dir, file);

function commitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: BACKEND_DIR,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'n/d';
  }
}

function table(head: string[], rows: string[][]): string {
  if (!rows.length) return '_Sem casos concluídos._\n';
  const line = (r: string[]): string => `| ${r.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n') + '\n';
}

function decisionText(d: BlockDecision): string {
  const pend = d.pending.length ? `\n\nA rotular: ${d.pending.join(', ')}` : '';
  return `**${d.verdict.toUpperCase()}**: ${d.text}\n\n${d.detail}${pend}\n`;
}

function editRows(dir: string, edits: EditResult[], labels: Labels): string[][] {
  return edits.map((e) => {
    const l = labels[e.key];
    const imgs = ['before', 'raw', 'final', e.mechanism]
      .map((k) => (e.files[k] ? `![](${rel(dir, e.files[k])})` : ''))
      .join(' ');
    const flags =
      [
        e.grown && 'grown',
        e.downscaled && 'downscaled',
        e.stretchFactor > 1 && `stretched×${e.stretchFactor.toFixed(2)}`,
        e.sizeMismatch && 'size_mismatch',
      ]
        .filter(Boolean)
        .join(' ') || '—';
    return [
      e.key,
      e.request.replace(/\|/g, '/'),
      fmt(e.metrics.insideMaskDiffRatio),
      fmt(e.metrics.outsideMaskDiffRatio),
      fmt(e.metrics.marginDiffRatio),
      `${e.insetScenePx ?? '—'} px`,
      fmt(e.metrics.maskAreaRatio, 4),
      fmt(e.metrics.seamSsim),
      flags,
      `US$ ${fmt(e.costUsd, 4)}`,
      `${e.latencyMs.provider ?? '—'} ms`,
      `${l?.edicao ?? 'pendente'} / ${l?.costura ?? 'pendente'}`,
      imgs,
    ];
  });
}

const METRIC_NOTE =
  '> **Mudança de métrica (decisão do dono, 2026-11-02):** o mecanismo do spike é o JSON com `mask` de alfa 255 = editar, e nele a saída bruta volta **preta** fora da região. Por isso `outsideMaskDiffRatio` da saída bruta (coluna "outside") vale cerca de 1 e **não mede obediência**; ela fica só como informação. A obediência passa a ser medida na imagem **recomposta**: `marginDiffRatio` é a fração de pixels alterados (τ = 16) na faixa de margem, isto é, dentro da região de recomposição (A recuada, com S inteira; o recuo é de 40 px medidos na saída do modelo e convertidos para a cena pela escala do recorte, ver a coluna "recuo (cena)" de cada caso) e fora de S. Fora da região de recomposição o final é idêntico ao original, conferido byte a byte.';

function obeyLine(c: Collected): string {
  const a = c.edits.filter((e) => e.block === 'A' && e.variant === 'base');
  return a.length
    ? `\nObediência na recomposta (marginDiffRatio, mask): ${summarizeBy(a, (e) => e.metrics.marginDiffRatio)}.\n`
    : '';
}

function markupNote(c: Collected): string {
  const off = Object.entries(c.status).filter(
    ([k, v]) => k.endsWith(':markup') && v.status === 'skipped',
  );
  return off.length
    ? `\nBraço ` +
        '`markup`' +
        `: ${off[0][1].reason} em ${off.length} pedidos; o mecanismo padrão sai do ` +
        '`mask`' +
        ` por exclusão (A2).\n`
    : '';
}

const EDIT_HEAD = [
  'caso',
  'pedido',
  'inside',
  'outside (bruta, informativa)',
  'margem (final)',
  'recuo (cena)',
  'área',
  'seamSsim',
  'flags',
  'custo',
  'latência',
  'rótulo (edição / costura)',
  'antes, bruta, final, máscara',
];

function costBlock(c: Collected): string {
  const groups = new Map<string, { cost: number[]; ms: number[] }>();
  for (const e of c.ledger.filter((x) => x.status !== 'error')) {
    const g = groups.get(`${e.block} / ${e.step}`) ?? { cost: [], ms: [] };
    g.cost.push(e.costUsd);
    g.ms.push(e.latencyMs);
    groups.set(`${e.block} / ${e.step}`, g);
  }
  const rows = [...groups.entries()].map(([k, g]) => {
    const co = summarize(g.cost);
    const la = summarize(g.ms);
    return [
      k,
      String(co.n),
      `US$ ${fmt(co.median, 4)}`,
      `US$ ${fmt(co.p90, 4)}`,
      `${Math.round(la.median)} ms`,
      `${Math.round(la.p90)} ms`,
    ];
  });
  const editMedian = summarize(
    c.ledger.filter((e) => e.step === 'edit' && e.status !== 'error').map((e) => e.costUsd),
  ).median;
  const warn =
    editMedian > 1
      ? '\n**Atenção:** a edição local tem custo mediano acima de US$ 1: a premissa do recorte (M2, cerca de 7x mais barato que a imagem inteira) é falsa.\n'
      : '';
  return (
    table(
      [
        'operação (bloco / etapa)',
        'chamadas',
        'custo mediano',
        'custo p90',
        'latência mediana',
        'latência p90',
      ],
      rows,
    ) + warn
  );
}

function visionBlock(c: Collected, labels: Labels): string {
  const map: Record<string, string[]> = {
    sim: ['atendeu'],
    parcial: ['parcial'],
    nao: ['nao_fez_nada', 'errado'],
  };
  const base = c.visions.filter((v) => v.forKey.endsWith(':mask') || v.forKey.endsWith(':markup'));
  const labeled = base.filter((v) => labels[v.forKey]?.edicao);
  const agree = labeled.filter(
    (v) => v.atendeu && map[v.atendeu]?.includes(labels[v.forKey].edicao as string),
  ).length;
  const verdict =
    labeled.length < base.length || !base.length
      ? `pendente: ${base.length - labeled.length} pedidos sem rótulo de edição`
      : agree >= 16
        ? `serve para redigir a resposta e detectar "não fez nada" (concordância ${agree}/${labeled.length})`
        : `não serve como gatilho (concordância ${agree}/${labeled.length})`;
  const rows = c.visions.map((v) => [
    v.forKey,
    v.parseOk ? (v.atendeu as string) : 'resposta fora do esquema',
    String(v.fez_algo ?? '—'),
    (v.mudou ?? v.text).replace(/\|/g, '/').slice(0, 90),
    labels[v.forKey]?.edicao ?? 'pendente',
  ]);
  return (
    `Modelo de visão: ${c.visions[0]?.model ?? 'n/d'}. Regra: concorda com o rótulo em ≥ 16 de 20 pedidos.\n\n**${verdict}**\n\n` +
    table(['caso', 'atendeu (visão)', 'fez algo', 'o que mudou', 'rótulo'], rows)
  );
}

function promoBlock(dir: string, c: Collected, labels: Labels): string {
  const rows = c.promos.map((p) => [
    p.promoId,
    p.target,
    p.atmospheric ? 'atmosférico' : 'destacável',
    `${(p.coverage * 100).toFixed(1)}%`,
    p.cutout,
    p.retouch
      .map(
        (r) =>
          `${r.band}: seam ${fmt(r.metrics.seamSsim, 2)} ${r.interiorPreserved ? 'interior ok' : 'INTERIOR ALTERADO'}`,
      )
      .join('; ') || '—',
    `US$ ${fmt(p.costUsd, 4)}`,
    labels[`${p.promoId}:promo`]?.global ?? 'pendente',
    ['before', 'pasted', 'final']
      .map((k) => (p.files[k] ? `![](${rel(dir, p.files[k])})` : ''))
      .join(' '),
  ]);
  const fb = c.fallbacks.map((f) => [
    f.promoId,
    f.target,
    `US$ ${fmt(f.costUsd, 4)}`,
    `${f.source.insetScenePx ?? '—'} / ${f.destination.insetScenePx ?? '—'} px`,
    labels[`${f.promoId}:fallback`]?.global ?? 'pendente',
    ['before', 'raw', 'final'].map((k) => `![](${rel(dir, f.files[k])})`).join(' '),
  ]);
  const skipped = Object.entries(c.status)
    .filter(([k, v]) => /:(promo|fallback)$/.test(k) && v.status !== 'done')
    .map(([k, v]) => `${k}: ${v.status}${v.reason ? ` (${v.reason})` : ''}`);
  return (
    table(
      [
        'caso',
        'item',
        'tipo',
        'cobertura alfa',
        'recorte',
        'retoque por faixa',
        'custo',
        'rótulo global',
        'antes, colado, final',
      ],
      rows,
    ) +
    `\nFallback (repintura de origem e destino):\n\n` +
    table(
      [
        'caso',
        'item',
        'custo',
        'recuo origem / destino (cena)',
        'rótulo global',
        'antes, bruta, final',
      ],
      fb,
    ) +
    (skipped.length ? `\nNão concluídos: ${skipped.join('; ')}\n` : '')
  );
}

function recTable(recs: Recommendation[]): string {
  return table(
    ['parâmetro', 'provisório', 'recomendado', 'base'],
    recs.map((r) => [r.parameter, r.provisional, r.recommended, r.basis]),
  );
}

const STAGE2 = [
  'Aceitar `mask` por JSON no mecanismo M3 (decisão do dono, 2026-11-02): imagem e máscara em data URL, **alfa 255 = editar** e alfa 0 = preservar, mesmo tamanho e formato do recorte, em `buildEditRequest`, hoje fechado em `model`, `image`, `prompt`, `size`, `quality`, `n`, `background`, `output_format`, `output_compression` e `input_fidelity`. O modelo devolve preto fora da região, então só a região de recomposição (A recuada) entra no final.',
  "`markup` **não entra**: a API recusa o parâmetro (`400 Unknown parameter: 'markup'`, 8 de 8 tentativas) apesar de documentá-lo (PV-19); revisitar só se a OpenAI o habilitar. O transporte é JSON (`client.post`), porque o multipart com alfa 0 deixou a região preta em 2 de 4 casos da comparação.",
  'Devolver o `usage` e o `x-request-id` de `generateImage` e `editImage` (hoje descartados) para gravar o custo real por chamada.',
  'Tamanhos customizados `WxH` (múltiplos de 16, 1:3 a 3:1, 655.360 a 8.294.400 px) e `quality` `xhigh|max` no modelo 2.5; o tamanho enviado pode precisar de esticamento do lado menor até 1,10 para atingir a área mínima (PV-20).',
  'Recorte com área mínima de 655.360 px e redução acima de 1024x1024, recomposição com feather 24 sobre A recuada (40 px na saída do modelo, convertidos para a cena, PV-17) e conferência byte a byte fora da região (funções puras de `scripts/template-scene-spike/`).',
];

export function buildReport(
  c: Collected,
  labels: Labels,
  cases: CasesFile,
  ctx: { dir: string; config: SpikeConfig; prices: Prices; dryRun: boolean },
): string {
  const { dir, config } = ctx;
  const aIds = cases.edits.filter((e) => e.block === 'A').map((e) => e.id);
  const cIds = cases.edits.filter((e) => e.block === 'C').map((e) => e.id);
  const promoRefs = cases.promotions.map((p) => ({ id: p.id, atmospheric: p.atmospheric }));
  const feather = recommendFeather(c.edits);
  // A1 pede costura invisível "com o feather escolhido": o rótulo vale no feather vencedor da varredura (PV-22).
  const seamField = feather.recommended.startsWith('48') ? 'costura_f48' : 'costura';
  const decA = decideA(labels, aIds, c.mechanisms, seamField);
  const decB = decideB(labels, promoRefs);
  const decC = decideC(labels, cIds);
  const edits = c.edits;
  const priceLines = [
    config.imageModel,
    config.visionModel,
    'replicate:851-labs/background-remover',
  ].map((k) => {
    const p = ctx.prices.entries[k];
    return p
      ? `- ${k}: ${(p.sources ?? []).join(', ')} (consulta ${p.consultedAt}); ${JSON.stringify(p.perMillionTokens ?? { perRunUsd: p.perRunUsd })}`
      : `- ${k}: SEM PREÇO`;
  });
  const recs = [
    recommendMargin(edits, labels),
    feather,
    recommendThreshold(edits, labels),
    recommendBand(labels, promoRefs),
    observeTau(edits),
  ];
  return [
    `# Relatório do spike da cena de template${ctx.dryRun ? ' (SIMULAÇÃO, dry-run)' : ''}`,
    `- Data: ${new Date().toISOString()}`,
    `- Commit do backend: ${commitSha()}`,
    `- Modelo de imagem: ${config.imageModel}, qualidade ${config.quality}; visão: ${config.visionModel}`,
    `- Gasto total (ledger): US$ ${fmt(c.spentUsd, 4)} de US$ ${config.budgetUsd.toFixed(2)}`,
    `- Conferência do painel da OpenAI (D-9): pendente`,
    `- Preços e fontes:\n${priceLines.join('\n')}`,
    '\nLegenda dos rótulos em `labels.json` (`_legenda`). Só `aceitavel` conta como aceito nas notas globais do bloco B.\n',
    `## Decisões por bloco\n\n### Bloco A, edição local (estágio 4)\n\n${decisionText(decA)}${markupNote(c)}${obeyLine(c)}\n### Bloco B, promoção a elemento (estágio 6)\n\n${decisionText(decB)}\n### Bloco C, sobreposição\n\n${decisionText(decC)}`,
    `${METRIC_NOTE}\n\n## Bloco A: pedidos\n\n${table(
      EDIT_HEAD,
      editRows(
        dir,
        edits.filter((e) => e.block === 'A' && e.variant !== 'm8'),
        labels,
      ),
    )}`,
    `Margem de 8% (só mask):\n\n${table(
      EDIT_HEAD,
      editRows(
        dir,
        edits.filter((e) => e.variant === 'm8'),
        labels,
      ),
    )}`,
    `## Bloco C: pincel ou laço contra retângulo\n\n${table(
      [...EDIT_HEAD, 'vizinha (bruta / final)'],
      editRows(
        dir,
        edits.filter((e) => e.block === 'C'),
        labels,
      ).map((r, i) => [
        ...r,
        `${fmt(edits.filter((e) => e.block === 'C')[i].neighbor?.rawDiffRatio)} / ${fmt(edits.filter((e) => e.block === 'C')[i].neighbor?.finalDiffRatio)}`,
      ]),
    )}`,
    `## Bloco B: promoção e fallback\n\n${promoBlock(dir, c, labels)}`,
    `## Bloco D: custo e latência\n\n${costBlock(c)}`,
    `## Bloco E: visão\n\n${visionBlock(c, labels)}`,
    `## Provisório para recomendado\n\n${recTable(recs)}`,
    `## O que o estágio 2 precisa acrescentar ao OpenAiImageService\n\n${STAGE2.map((s) => `- ${s}`).join('\n')}\n`,
  ].join('\n\n');
}

/** Procura os valores das chaves em todos os arquivos de texto da saída; falha se achar. */
export function assertNoKeys(dir: string, values: string[]): void {
  const secrets = values.filter((v) => v && v.length >= 8);
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (!/\.(png|webp|jpe?g)$/i.test(name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (secrets.some((s) => text.includes(s))) throw new Error(`Uma chave apareceu em ${full}`);
      }
    }
  };
  walk(dir);
}

export function writeReport(
  dir: string,
  cases: CasesFile,
  config: SpikeConfig,
  prices: Prices,
  dryRun: boolean,
): string {
  const c = collect(dir, cases);
  const keys = [
    ...c.edits.map((e) => e.key),
    ...c.promos.map((p) => p.key),
    ...c.fallbacks.map((f) => f.key),
  ];
  const labels = ensureLabels(dir, keys);
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, buildReport(c, labels, cases, { dir, config, prices, dryRun }), 'utf8');
  assertNoKeys(dir, [config.openaiKey, config.replicateToken]);
  return file;
}
