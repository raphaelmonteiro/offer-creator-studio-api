import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';
import { collect } from './collect';
import type { EditResult } from './edit-cases';
import { FORMATS } from './formats';
import { readLabels } from './labels';
import type { LabelEntry, Labels } from './labels';
import type { CasesFile, MaskShape, Rect } from './types';

const PREVIEW_EDGE = 1024;
const EDIT_RANK: Record<string, number> = { atendeu: 0, parcial: 1, nao_fez_nada: 2, errado: 3 };
const GLOBAL_RANK: Record<string, number> = { aceitavel: 0, sim: 1, nao: 2 };

export interface ManifestCase {
  id: string;
  block: 'A' | 'B' | 'C';
  prompt: string;
  region: Rect;
  mask?: MaskShape;
  mechanism: string;
  before: string;
  rawOutput: string;
  final: string;
  metrics: Record<string, unknown>;
  costUsd: number;
  latencyMs: Record<string, number>;
  label: LabelEntry | null;
  worst: boolean;
  /** Ordenação interna do pior caso; não vai para o arquivo. */
  _rank?: [number, number];
}

async function preview(src: string, dest: string): Promise<string> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await sharp(src)
    .resize(PREVIEW_EDGE, PREVIEW_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(dest);
  return dest;
}

const slug = (key: string): string => key.replace(/[^A-Za-z0-9_.-]/g, '_');

function editRank(e: EditResult, label: LabelEntry | null): [number, number] {
  const byLabel = label?.edicao ? (EDIT_RANK[label.edicao] ?? -1) : -1;
  const score =
    e.metrics.outsideMaskDiffRatio -
    e.metrics.insideMaskDiffRatio +
    (1 - (e.metrics.seamSsim ?? 1));
  return [byLabel, score];
}

/** Exatamente um `worst: true` por bloco: pior rótulo e, no empate ou sem rótulo, a pior métrica. */
export function markWorst(entries: ManifestCase[]): void {
  for (const block of ['A', 'B', 'C'] as const) {
    const group = entries.filter((e) => e.block === block);
    if (!group.length) continue;
    const best = group.reduce((a, b) => {
      const [la, sa] = a._rank as [number, number];
      const [lb, sb] = b._rank as [number, number];
      return lb > la || (lb === la && sb > sa) ? b : a;
    });
    best.worst = true;
  }
}

const sumMs = (steps: Array<Record<string, number>>): Record<string, number> =>
  steps.reduce<Record<string, number>>((acc, s) => {
    for (const [k, v] of Object.entries(s)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});

/** Pacote para o mock do protótipo: prévias WebP de até 1024 px e `manifest.json` (D-7). */
export async function writeFixtures(dir: string, cases: CasesFile): Promise<string> {
  const c = collect(dir, cases);
  const labels: Labels = readLabels(dir);
  const out = path.join(dir, 'fixtures');
  fs.rmSync(out, { recursive: true, force: true });
  const scenes = [];
  for (const s of cases.scenes) {
    const file = path.join(dir, 'scenes', `${s.id}.png`);
    if (!fs.existsSync(file)) continue;
    const meta = await sharp(file).metadata();
    const f = FORMATS[s.formatId];
    const prev = await preview(file, path.join(out, 'scenes', `${s.id}.webp`));
    scenes.push({
      id: s.id,
      formatId: s.formatId,
      artWidthCm: f.artWidthCm,
      artHeightCm: f.artHeightCm,
      sizePx: { width: meta.width, height: meta.height },
      scenePreview: path.relative(out, prev),
    });
  }
  const entries: ManifestCase[] = [];
  const rel = (p: string): string => path.relative(out, p);
  for (const e of c.edits) {
    const base = path.join(out, 'cases', slug(e.key));
    const label = labels[e.key] ?? null;
    entries.push({
      id: e.key,
      block: e.block as 'A' | 'C',
      prompt: e.request,
      region: e.region,
      mask: e.mask as MaskShape | undefined,
      mechanism: e.mechanism,
      before: rel(await preview(e.files.before, `${base}/before.webp`)),
      rawOutput: rel(await preview(e.files.raw, `${base}/raw.webp`)),
      final: rel(await preview(e.files.final, `${base}/final.webp`)),
      metrics: { ...e.metrics, neighbor: e.neighbor, grown: e.grown, downscaled: e.downscaled },
      costUsd: e.costUsd,
      latencyMs: e.latencyMs,
      label,
      worst: false,
      _rank: editRank(e, label),
    });
  }
  for (const p of c.promos) {
    const base = path.join(out, 'cases', slug(p.key));
    const def = cases.promotions.find((x) => x.id === p.promoId)!;
    const label = labels[p.key] ?? null;
    const seam = Math.min(...p.retouch.map((r) => r.metrics.seamSsim ?? 1), 1);
    const empty = p.cutout === 'vazio';
    entries.push({
      id: p.key,
      block: 'B',
      prompt: def.prompt,
      region: p.destination,
      mechanism: 'promocao',
      before: empty ? '' : rel(await preview(p.files.before, `${base}/before.webp`)),
      rawOutput: empty ? '' : rel(await preview(p.files.pasted, `${base}/raw.webp`)),
      final: empty ? '' : rel(await preview(p.files.final, `${base}/final.webp`)),
      metrics: {
        coverage: p.coverage,
        cutout: p.cutout,
        retouch: p.retouch.map((r) => ({
          band: r.band,
          seamSsim: r.metrics.seamSsim,
          interiorPreserved: r.interiorPreserved,
        })),
      },
      costUsd: p.costUsd,
      latencyMs: {
        remove_bg: p.removeLatencyMs,
        ...sumMs([p.fill?.latencyMs ?? {}, ...p.retouch.map((r) => r.latencyMs)]),
      },
      label,
      worst: false,
      _rank: [label?.global ? (GLOBAL_RANK[label.global] ?? -1) : -1, empty ? 10 : 1 - seam],
    });
  }
  for (const f of c.fallbacks) {
    const base = path.join(out, 'cases', slug(f.key));
    const def = cases.promotions.find((x) => x.id === f.promoId)!;
    const label = labels[f.key] ?? null;
    entries.push({
      id: f.key,
      block: 'B',
      prompt: def.prompt,
      region: def.destination as Rect,
      mechanism: 'fallback',
      before: rel(await preview(f.files.before, `${base}/before.webp`)),
      rawOutput: rel(await preview(f.files.raw, `${base}/raw.webp`)),
      final: rel(await preview(f.files.final, `${base}/final.webp`)),
      metrics: { source: f.source.metrics, destination: f.destination.metrics },
      costUsd: f.costUsd,
      latencyMs: sumMs([f.source.latencyMs, f.destination.latencyMs]),
      label,
      worst: false,
      _rank: [
        label?.global ? (GLOBAL_RANK[label.global] ?? -1) : -1,
        1 - (f.destination.metrics.seamSsim ?? 1),
      ],
    });
  }
  markWorst(entries);
  const cleaned = entries.map(({ _rank, ...rest }) => (void _rank, rest));
  const file = path.join(out, 'manifest.json');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ generatedAt: new Date().toISOString(), scenes, cases: cleaned }, null, 2),
    'utf8',
  );
  return file;
}
