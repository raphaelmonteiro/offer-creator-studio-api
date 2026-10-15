/**
 * Gate de boca legível (change video-formatos-personagem, D4 / spec
 * video-character-kit "Gate de boca legível"): parte PURA — veredito,
 * decisão e parse da resposta do modelo de visão. O IO (Gemini) fica em
 * services/mc-mouth-gate.service.ts.
 *
 * O veredito é gravado no kit (`mc_character_kits.mouthGate` jsonb) em duas
 * ocasiões: no logo cru, na criação de um kit `source = 'logo'` (decide se
 * "usar como está" aparece), e na identidade, antes da aprovação (bloqueia
 * ou pede aceite de risco).
 */

/** Caixa normalizada (0..1, origem no canto superior esquerdo) do rosto/cabeça. */
export interface McNormalizedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface McMouthVerdict {
  hasMouth: boolean;
  mouthOpenPossible: boolean;
  /** 0..1 — abaixo de MC_MOUTH_GATE_MIN_CONFIDENCE o veredito é "indeciso". */
  confidence: number;
  /** Rosto/cabeça do personagem (normalizado); null quando o modelo não achou rosto. */
  bbox: McNormalizedBox | null;
  model: string;
  at: string;
  /** Veredito sintético (MC_KIT_PROVIDER=mock) — nunca gastou visão. */
  mock?: boolean;
  /** Visão indisponível: veredito indeciso com o motivo (fail-open para o aceite com risco). */
  error?: string;
  /**
   * A visão RESPONDEU (e cobrou) sem veredito legível: indeciso com `error`,
   * mas reaproveitável na aprovação do mesmo asset (o aceite de risco não
   * paga a visão de novo). Ausente = sem resposta cobrada (re-inspeciona).
   */
  paid?: boolean;
}

export type McMouthDecision = 'passed' | 'blocked' | 'undecided';

/** Confiança mínima para o veredito decidir sozinho (abaixo disso o usuário assume o risco). */
export const MC_MOUTH_GATE_MIN_CONFIDENCE = 0.7;

/** Estado persistido no kit (jsonb `mouthGate`). */
export interface McKitMouthGate {
  /** Veredito sobre o logo cru (criação de kit `logo`). */
  logo?: McMouthVerdict;
  /** Veredito sobre a identidade avaliada antes da aprovação. */
  identity?: McMouthVerdict & { identityAssetId: string };
  /** Aceite explícito do risco (veredito indeciso) registrado na aprovação. */
  riskAccepted?: { at: string; identityAssetId: string; confidence: number };
}

/**
 * passed: boca com abertura articulável, com confiança; blocked: confiança
 * de que NÃO há boca articulável; undecided: o modelo não decidiu (ou a
 * visão falhou) — a aprovação só segue com `acceptMouthRisk`.
 */
export function decideMouthGate(verdict: McMouthVerdict | null | undefined): McMouthDecision {
  if (!verdict) return 'undecided';
  if (!(verdict.confidence >= MC_MOUTH_GATE_MIN_CONFIDENCE)) return 'undecided';
  return verdict.hasMouth && verdict.mouthOpenPossible ? 'passed' : 'blocked';
}

/** Prompt do veredito (JSON compacto, chaves em snake_case como no contrato da tarefa 2.7). */
export const MC_MOUTH_GATE_PROMPT = [
  'You are checking whether a character image can be lip-synced by a talking-avatar video model.',
  'The image is a brand mascot or a brand logo. Answer ONLY with compact JSON:',
  '{"has_mouth": true|false, "mouth_open_possible": true|false, "confidence": 0.0-1.0,',
  '"bbox": {"x": 0.0-1.0, "y": 0.0-1.0, "w": 0.0-1.0, "h": 0.0-1.0} | null}.',
  '"has_mouth": there is an identifiable mouth on a face. "mouth_open_possible": the mouth is',
  'drawn with an opening or lips that could visibly open and close (a single thin line, a dot,',
  'or no mouth at all means false). "confidence": how sure you are about both answers.',
  '"bbox": the bounding box of the face/head that contains the mouth, normalized to the image',
  'size with the origin at the top-left corner; null when there is no face.',
].join(' ');

function clamp01(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** Caixa válida = quatro números finitos em 0..1 com área positiva; qualquer outra coisa vira null. */
export function parseNormalizedBox(value: unknown): McNormalizedBox | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const x = clamp01(raw.x);
  const y = clamp01(raw.y);
  const w = clamp01(raw.w);
  const h = clamp01(raw.h);
  if (x == null || y == null || w == null || h == null || w <= 0 || h <= 0) return null;
  const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
  return {
    x: round4(x),
    y: round4(y),
    w: round4(Math.min(w, 1 - x)),
    h: round4(Math.min(h, 1 - y)),
  };
}

/**
 * Parse tolerante da resposta do modelo: acha o primeiro objeto JSON no texto
 * (o modelo às vezes cerca com ```json). Sem `has_mouth` booleano → null
 * (quem chama trata como indeciso).
 */
export function parseMouthVerdict(
  text: string,
): Pick<McMouthVerdict, 'hasMouth' | 'mouthOpenPossible' | 'confidence' | 'bbox'> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.has_mouth !== 'boolean') return null;
    const hasMouth = parsed.has_mouth;
    const mouthOpenPossible = hasMouth && parsed.mouth_open_possible === true;
    return {
      hasMouth,
      mouthOpenPossible,
      confidence: clamp01(parsed.confidence) ?? 0,
      bbox: parseNormalizedBox(parsed.bbox),
    };
  } catch {
    return null;
  }
}
