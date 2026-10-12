/**
 * Preflight de render por formato (change video-formatos-personagem, design D14;
 * spec video-composition-render "Preflight por formato").
 *
 * Parte PURA: vocabulário de requisitos, matriz formato → requisitos e o
 * resumo a partir das checagens. O `RenderPreflightService` executa as
 * checagens no worker; o resultado viaja no heartbeat (system_settings) e é
 * lido pelo /v1/health e pelos gates de criação de projeto.
 *
 * Fica em shared (não em commercials) porque o heartbeat é infraestrutura
 * neutra e a fronteira do ESLint proíbe shared → commercials.
 */

/** Espelho de McProjectFormat (commercials/domain/mc-types) sem importar o módulo de feature. */
export const RENDER_FORMATS = ['scenes', 'talking_art', 'offer_carousel'] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

export const RENDER_REQUIREMENT_IDS = ['ffmpeg', 'ffprobe', 'fonts', 'browser'] as const;
export type RenderRequirementId = (typeof RENDER_REQUIREMENT_IDS)[number];

/**
 * Requisitos por formato: compositor e sonda de vídeo e fontes para todos;
 * o navegador de render só para "ofertas em sequência" (Remotion). A versão
 * da composição (`compositionVersion`) entra nessa checagem quando o pacote
 * de templates existir (grupo 6 das tarefas).
 */
export const RENDER_REQUIREMENTS: Record<RenderFormat, readonly RenderRequirementId[]> = {
  scenes: ['ffmpeg', 'ffprobe', 'fonts'],
  talking_art: ['ffmpeg', 'ffprobe', 'fonts'],
  offer_carousel: ['ffmpeg', 'ffprobe', 'fonts', 'browser'],
};

export interface RenderRequirementCheck {
  id: RenderRequirementId;
  ok: boolean;
  /** Versão ou caminho resolvido, quando disponível. */
  version?: string | null;
  /** Motivo legível quando `ok === false` (vai para o health e para o erro do gate). */
  detail?: string;
}

export interface RenderFormatAvailability {
  available: boolean;
  missing: RenderRequirementId[];
}

export interface RenderPreflight {
  checkedAt: string; // ISO-8601
  versions: Partial<Record<RenderRequirementId, string>>;
  /** Motivo de cada requisito que falhou (ex.: fonts → "DejaVu Sans não encontrada (…)"). */
  details: Partial<Record<RenderRequirementId, string>>;
  checks: RenderRequirementCheck[];
  formats: Record<RenderFormat, RenderFormatAvailability>;
}

/** Resume as checagens brutas em disponibilidade por formato (puro, testável). */
export function summarizeRenderPreflight(
  checks: RenderRequirementCheck[],
  checkedAt: string,
): RenderPreflight {
  const okById = new Map<RenderRequirementId, boolean>();
  const versions: Partial<Record<RenderRequirementId, string>> = {};
  const details: Partial<Record<RenderRequirementId, string>> = {};
  for (const check of checks) {
    okById.set(check.id, check.ok);
    if (check.ok && check.version) versions[check.id] = check.version;
    if (!check.ok) details[check.id] = check.detail ?? 'faltando';
  }
  const formats = {} as Record<RenderFormat, RenderFormatAvailability>;
  for (const format of RENDER_FORMATS) {
    const missing = RENDER_REQUIREMENTS[format].filter((id) => okById.get(id) !== true);
    formats[format] = { available: missing.length === 0, missing };
  }
  return { checkedAt, versions, details, checks, formats };
}

/**
 * Requisitos faltantes de um formato segundo o último preflight conhecido.
 * `null` = desconhecido (o worker ainda não publicou preflight) — o chamador
 * decide se bloqueia; os gates de criação NÃO bloqueiam no desconhecido, só
 * no "faltante" comprovado (spec: "quando falta requisito desse formato").
 */
export function renderMissingFor(
  format: RenderFormat,
  preflight: RenderPreflight | null | undefined,
): RenderRequirementId[] | null {
  if (!preflight?.formats) return null;
  const entry = preflight.formats[format];
  if (!entry) return null;
  return entry.missing ?? [];
}
