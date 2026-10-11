import { canOverwriteEan, EanSource, ProductMetadata } from './product-metadata.schema';

/**
 * Campos que formam o "bloco EAN" do metadata de uma imagem: o código e toda a
 * sua proveniência. Andam sempre juntos — copiar o EAN sem a fonte é o que faz,
 * meses depois, ninguém saber em qual valor confiar.
 */
export const EAN_BLOCK_KEYS = [
  'ean',
  'eanSource',
  'eanConfidence',
  'eanVerifiedAt',
  'eanStatus',
  'eanCandidates',
  'eanVerifiedBy',
  'eanJobId',
] as const;

type EanBlock = Pick<ProductMetadata, (typeof EAN_BLOCK_KEYS)[number]>;

export interface MergeEanOptions {
  /**
   * Permite APAGAR o EAN atual, mas só quando ele veio desta fonte. É o caso
   * da unicidade de GTIN da OFF, que rejeita os próprios vínculos disputados;
   * um EAN de fonte melhor nunca é apagado por ela.
   */
  clearEanSource?: EanSource;
}

function pickEanBlock(metadata: ProductMetadata): EanBlock {
  const block: Record<string, unknown> = {};
  for (const key of EAN_BLOCK_KEYS) {
    if (metadata[key] !== undefined) block[key] = metadata[key];
  }
  return block as EanBlock;
}

function withoutEanBlock(metadata: ProductMetadata): ProductMetadata {
  const copy: Record<string, unknown> = { ...metadata };
  for (const key of EAN_BLOCK_KEYS) delete copy[key];
  return copy as ProductMetadata;
}

function addWarning(metadata: ProductMetadata, warning: string): ProductMetadata {
  const warnings = metadata.warnings ?? [];
  if (warnings.includes(warning)) return metadata;
  return { ...metadata, warnings: [...warnings, warning] };
}

/** Mantém o bloco EAN de `current` sobre os campos descritivos de `incoming`. */
function keepCurrent(
  current: ProductMetadata,
  incoming: ProductMetadata,
  divergentEan: string | null,
): ProductMetadata {
  const merged = { ...withoutEanBlock(incoming), ...pickEanBlock(current) } as ProductMetadata;
  return divergentEan ? addWarning(merged, `ean-divergente:${divergentEan}`) : merged;
}

/**
 * Decide o metadata a gravar quando um processo reescreve o de uma imagem.
 *
 * - `incoming` sem EAN (ex.: nova extração por visão que não leu código) →
 *   os campos descritivos são atualizados e o bloco EAN atual é preservado;
 * - `incoming` com EAN e fonte → vale a precedência de `canOverwriteEan`;
 *   perdendo, o EAN atual fica e o lido vira aviso `ean-divergente:<ean>`;
 * - `incoming` com EAN sem fonte (leitura solta) nunca substitui um EAN com
 *   fonte; só substitui outro EAN também sem fonte (metadata legado).
 */
export function mergeEanBlock(
  current: ProductMetadata | null | undefined,
  incoming: ProductMetadata,
  options: MergeEanOptions = {},
): ProductMetadata {
  if (!current?.ean) return incoming;

  if (!incoming.ean) {
    if (options.clearEanSource && current.eanSource === options.clearEanSource) return incoming;
    return keepCurrent(current, incoming, null);
  }

  const incomingSource = incoming.eanSource ?? null;
  const currentSource = current.eanSource ?? null;

  if (!incomingSource) {
    if (!currentSource) return incoming;
    return keepCurrent(current, incoming, incoming.ean === current.ean ? null : incoming.ean);
  }

  if (canOverwriteEan(currentSource, incomingSource)) return incoming;
  return keepCurrent(current, incoming, incoming.ean === current.ean ? null : incoming.ean);
}
