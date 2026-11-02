import * as fs from 'fs';
import { CASES_PATH, imagePrice, loadPrices, PRICES_PATH } from './config';
import type { Prices, SpikeConfig } from './config';
import { FORMATS, nativeSize } from './formats';
import type { FormatSpec, NativeSize } from './formats';
import type { CasesFile } from './types';

export function loadCases(file: string = CASES_PATH): CasesFile {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CasesFile;
}

export interface PlanValidation {
  errors: string[];
  sizes: Record<string, NativeSize>;
  missingRegions: string[];
}

/** Valida casos e formatos sem rede: ids únicos, cenas e formatos conhecidos, proporção 1:3 a 3:1. */
export function validateCases(
  cases: CasesFile,
  formats: Record<string, FormatSpec> = FORMATS,
): PlanValidation {
  const errors: string[] = [];
  const sizes: Record<string, NativeSize> = {};
  const ids = new Set<string>();
  const unique = (id: string): void => {
    if (ids.has(id)) errors.push(`Id repetido: ${id}`);
    ids.add(id);
  };
  for (const scene of cases.scenes) {
    unique(scene.id);
    const format = formats[scene.formatId];
    if (!format) {
      errors.push(`Cena ${scene.id}: formato desconhecido ${scene.formatId}`);
      continue;
    }
    try {
      sizes[scene.id] = nativeSize(format.artWidthCm, format.artHeightCm);
    } catch (e) {
      errors.push(`Cena ${scene.id} (${scene.formatId}): ${(e as Error).message}`);
    }
  }
  const sceneIds = new Set(cases.scenes.map((s) => s.id));
  for (const edit of cases.edits) {
    unique(edit.id);
    if (!sceneIds.has(edit.sceneId))
      errors.push(`Caso ${edit.id}: cena ${edit.sceneId} inexistente`);
    if (edit.shapeKind === 'zone' && !edit.zone) errors.push(`Caso ${edit.id}: zona sem nome`);
  }
  for (const promo of cases.promotions) {
    unique(promo.id);
    if (!sceneIds.has(promo.sceneId))
      errors.push(`Caso ${promo.id}: cena ${promo.sceneId} inexistente`);
  }
  for (const id of cases.marginSubset) {
    if (!cases.edits.some((e) => e.id === id && e.block === 'A'))
      errors.push(`Margem de 8%: ${id} não é do bloco A`);
  }
  return { errors, sizes, missingRegions: missingRegions(cases) };
}

/** Casos que ainda não têm região marcada (preenchida na task 1.8). */
export function missingRegions(cases: CasesFile): string[] {
  const missing: string[] = [];
  for (const e of cases.edits) {
    const needsRect = e.shapeKind !== 'zone';
    const needsMask = e.shapeKind === 'brush' || e.shapeKind === 'lasso';
    if ((needsRect && !e.region) || (needsMask && !e.mask)) missing.push(e.id);
    if (e.block === 'C' && !e.neighbor) missing.push(`${e.id} (neighbor)`);
  }
  for (const p of cases.promotions) {
    if (!p.source || !p.destination) missing.push(p.id);
  }
  return missing;
}

/** Faixa por edição de recorte de ~1024 px com entrada (brief M2: US$ 0,2 a 0,35). */
const EDIT_USD: [number, number] = [0.2, 0.35];
const VISION_USD = 0.03;
const RETRY_FACTOR = 1.3;
/**
 * Tokens de saída por pixel observados na fase 1 real (2026-11-02, `high`): 2700 a 4523 tokens para
 * 7,3 a 8,3 Mpx, média 0,00046. O brief (M2) previa 0,0039, cerca de 8x mais.
 */
const OUT_TOKENS_PER_PIXEL = 0.00046;

export interface PlanLine {
  item: string;
  calls: number;
  lowUsd: number;
  highUsd: number;
}

export function estimatePlan(
  cases: CasesFile,
  sizes: Record<string, NativeSize>,
  config: SpikeConfig,
  prices: Prices,
): PlanLine[] {
  const price = imagePrice(prices, config.imageModel, config.quality);
  const generate = cases.scenes.reduce((sum, s) => {
    const size = sizes[s.id];
    return (
      sum +
      (size
        ? (size.width * size.height * OUT_TOKENS_PER_PIXEL * price.perMillionTokens.imageOutput) /
          1e6
        : 0)
    );
  }, 0);
  const a = cases.edits.filter((e) => e.block === 'A').length;
  const c = cases.edits.filter((e) => e.block === 'C').length;
  const b = cases.promotions.length;
  const line = (item: string, calls: number, unit: [number, number]): PlanLine => ({
    item,
    calls,
    lowUsd: calls * unit[0],
    highUsd: calls * unit[1],
  });
  const lines: PlanLine[] = [
    { item: 'Fase 1 (cenas)', calls: cases.scenes.length, lowUsd: generate, highUsd: generate },
    line('A (pedidos x 2 mecanismos)', a * 2, EDIT_USD),
    line('Margem 8%', cases.marginSubset.length, EDIT_USD),
    line('C (retângulo e pincel/laço)', c * 2, EDIT_USD),
    line('B promoção (preenchimento + 3 retoques)', b * 4, EDIT_USD),
    line('B fallback (origem e destino)', b * 2, EDIT_USD),
    line('B remoção de fundo (Replicate)', b, [0.00051, 0.00051]),
    line('E visão', a * 2 + 5, [VISION_USD, VISION_USD]),
  ];
  const subtotalLow = lines.reduce((s, l) => s + l.lowUsd, 0);
  const subtotalHigh = lines.reduce((s, l) => s + l.highUsd, 0);
  lines.push({
    item: `Retomadas e retentativas (+${Math.round((RETRY_FACTOR - 1) * 100)}%)`,
    calls: 0,
    lowUsd: subtotalLow * (RETRY_FACTOR - 1),
    highUsd: subtotalHigh * (RETRY_FACTOR - 1),
  });
  return lines;
}

export function runPlan(
  config: SpikeConfig,
  strict: boolean,
  cases: CasesFile = loadCases(),
): void {
  const prices = loadPrices(PRICES_PATH);
  imagePrice(prices, config.imageModel, config.quality);
  const result = validateCases(cases);
  const out = (s: string): void => void process.stdout.write(`${s}\n`);
  out(
    `Plano: ${cases.scenes.length} cenas, ${cases.edits.length} edições, ${cases.promotions.length} promoções`,
  );
  out(`Modelo ${config.imageModel}, qualidade ${config.quality}, teto US$ ${config.budgetUsd}\n`);
  out('Tamanho nativo por cena:');
  for (const scene of cases.scenes) {
    const size = result.sizes[scene.id];
    out(
      `  ${scene.id}  ${scene.formatId.padEnd(16)} ${size ? `${size.width}x${size.height}` : 'RECUSADO'}`,
    );
  }
  if (result.errors.length) {
    out('\nErros:');
    result.errors.forEach((e) => out(`  - ${e}`));
    throw new Error(`${result.errors.length} erro(s) no plano; nenhuma chamada foi feita`);
  }
  const lines = estimatePlan(cases, result.sizes, config, prices);
  out('\nEstimativa de custo (ordem de grandeza; o ledger traz o custo real):');
  for (const l of lines)
    out(
      `  ${l.item.padEnd(44)} ${String(l.calls).padStart(3)}  US$ ${l.lowUsd.toFixed(2)} a ${l.highUsd.toFixed(2)}`,
    );
  const low = lines.reduce((s, l) => s + l.lowUsd, 0);
  const high = lines.reduce((s, l) => s + l.highUsd, 0);
  out(
    `  ${'Total'.padEnd(44)}      US$ ${low.toFixed(2)} a ${high.toFixed(2)} (teto US$ ${config.budgetUsd})`,
  );
  out(
    `\nCasos sem região marcada: ${result.missingRegions.length}${result.missingRegions.length ? ` (${result.missingRegions.join(', ')})` : ''}`,
  );
  if (strict && result.missingRegions.length) throw new Error('Há casos sem região (--strict)');
}
