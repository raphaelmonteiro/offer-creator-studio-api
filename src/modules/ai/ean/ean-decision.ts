import type {
  AiDecisionRecord,
  EanMatchItemStatus,
  EanReferenceRecord,
  EanReviewReason,
  JudgmentRecord,
  LabelReadout,
} from './ean-match.types';
import { brandsCompatible } from './gs1-prefix-map';
import { normalizeBrand, parseFreeTextQuantity, quantityMatches } from './gtin.util';
import { variantGate } from './variant-token.util';

export interface DecisaoItem {
  status: EanMatchItemStatus;
  reviewReason: EanReviewReason | null;
  aiDecision: AiDecisionRecord;
}

/**
 * Regra de auto-aceite (spec ean-match-adjudication, design §7). Aceita só
 * se TUDO valer: juízes concordam, há referência oficial, o rótulo lido bate
 * com a referência em marca/variante/quantidade e a calibração liberou.
 * Qualquer falha manda para revisão — nunca "escolhe o mais provável".
 */
export function decidir(input: {
  judgments: JudgmentRecord[];
  reference: EanReferenceRecord | null;
  descricao: string;
  calibracaoLiberada: boolean;
}): DecisaoItem {
  const [a, b] = input.judgments;
  const vazio = (failed: EanReviewReason[], consensus = false): AiDecisionRecord => ({
    decision: a?.decision ?? 'none',
    imageIds: a?.imageIds ?? [],
    consensus,
    autoAcceptEligible: false,
    failed,
  });

  if (!a || !b || a.error || b.error) {
    return {
      status: 'review',
      reviewReason: 'invalid-judgment',
      aiDecision: vazio(['invalid-judgment']),
    };
  }

  const consenso = a.decision === b.decision && mesmoConjunto(a.imageIds, b.imageIds);
  if (!consenso) {
    return {
      status: 'review',
      reviewReason: 'judges-disagree',
      aiDecision: vazio(['judges-disagree']),
    };
  }

  const temReferencia = Boolean(
    input.reference && input.reference.source !== 'none' && input.reference.name,
  );

  if (a.decision === 'none') {
    const aiDecision: AiDecisionRecord = {
      decision: 'none',
      imageIds: [],
      consensus: true,
      autoAcceptEligible: temReferencia,
      failed: temReferencia ? [] : ['no-reference'],
    };
    return temReferencia
      ? { status: 'no-image', reviewReason: null, aiDecision }
      : { status: 'review', reviewReason: 'no-reference', aiDecision };
  }

  const failed: EanReviewReason[] = [];
  if (!temReferencia) failed.push('no-reference');
  else {
    const leituras = [...a.labelReadout, ...b.labelReadout];
    const todasCobertas = a.imageIds.every(
      (id) =>
        a.labelReadout.some((l) => l.imageId === id) &&
        b.labelReadout.some((l) => l.imageId === id),
    );
    if (
      !todasCobertas ||
      !leituras.every((l) => rotuloCompativel(l, input.reference!, input.descricao))
    ) {
      failed.push('label-mismatch');
    }
  }

  const elegivel = failed.length === 0;
  if (!input.calibracaoLiberada) failed.push('calibration-off');

  const aiDecision: AiDecisionRecord = {
    decision: a.decision,
    imageIds: [...a.imageIds].sort(),
    consensus: true,
    autoAcceptEligible: elegivel,
    failed,
  };
  return failed.length === 0
    ? { status: 'auto-accepted', reviewReason: null, aiDecision }
    : { status: 'review', reviewReason: failed[0], aiDecision };
}

/**
 * O que o juiz LEU no rótulo é coerente com a referência oficial?
 * - marca: obrigatória e compatível com a marca oficial;
 * - variante: sem conflito com a referência nem com a descrição do ERP;
 * - quantidade: se a referência (ou o ERP) declara, o rótulo precisa declarar
 *   a mesma. Ausência no rótulo reprova — sem evidência, sem auto-aceite.
 */
export function rotuloCompativel(
  leitura: LabelReadout,
  referencia: EanReferenceRecord,
  descricao: string,
): boolean {
  const marcaLida = normalizeBrand(leitura.brand);
  if (!marcaLida) return false;
  const marcasOficiais = String(referencia.brand ?? '')
    .split(',')
    .map((m) => normalizeBrand(m))
    .filter(Boolean);
  if (marcasOficiais.length > 0) {
    if (!marcasOficiais.some((m) => brandsCompatible(m, marcaLida))) return false;
  } else if (!` ${normalizeBrand(referencia.name)} `.includes(` ${marcaLida} `)) {
    return false;
  }

  const textoLido = [leitura.brand, leitura.variant, leitura.quantity].filter(Boolean).join(' ');
  for (const lado of [referencia.name ?? '', descricao]) {
    if (lado && variantGate(lado, textoLido).reason === 'conflito-de-variante') return false;
  }

  const qtdOficial =
    parseFreeTextQuantity(referencia.quantity) ??
    parseFreeTextQuantity(referencia.name) ??
    parseFreeTextQuantity(descricao);
  if (qtdOficial) {
    const qtdLida = parseFreeTextQuantity(leitura.quantity);
    if (!qtdLida || !quantityMatches(qtdOficial, qtdLida)) return false;
  }
  return true;
}

function mesmoConjunto(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
