import { KitCanonicalDesc, userAdjustmentsLine } from './kit-prompts';
import { McKitSource, McKitStyle, styleBlockLine } from './mc-kit-identity';

/**
 * Prompt do keyframe de cena (plano-comerciais §5.1 etapa 2): ação da cena +
 * descrição canônica do kit + estilo — o keyframe é a prévia barata do gate de
 * storyboard e vira o first frame/imagem do Avatar. Função pura (mesmo contrato
 * de reprodutibilidade do kit-prompts: mudar o texto = bump do builder version
 * no input-hash).
 *
 * A fidelidade visual vem das 2–3 imagens de referência do kit anexadas como
 * inlineData; o texto ancora enquadramento vertical e a regra de nunca
 * renderizar texto/preço (plano §5.4 — selos são camada determinística).
 *
 * Change video-formatos-personagem (D5): o estilo fixo do kit (`STYLE_BLOCKS`)
 * entra nos dois builders de keyframe; `adjustments` deixa de ser alavanca de
 * estilo; com `source = 'logo'` as marcas do logo são identidade, não "logo
 * proibido". O estilo entra no hash do keyframe (mc-step-hashes).
 */

/** Identidade do kit que muda o texto do keyframe (ausente = comportamento legado). */
export interface KeyframeIdentityOptions {
  style?: McKitStyle | null;
  source?: McKitSource | null;
}

/**
 * Bloco da ficha compartilhado pelos dois builders: com estilo fixo, o estilo
 * livre da ficha NÃO entra (não disputa com o bloco) e os ajustes do usuário
 * perdem a "highest priority".
 */
function characterSheetLines(
  desc: KitCanonicalDesc,
  styleFixed: boolean,
  propsRule: string,
  traitsLabel: string,
): string[] {
  const lines: string[] = ['', 'Character sheet (keep the character EXACTLY like this):'];
  if (desc.traits.length > 0) lines.push(`- ${traitsLabel}: ${desc.traits.join('; ')}`);
  if (desc.colors.length > 0) lines.push(`- Colors: ${desc.colors.join(', ')}`);
  if (desc.style && !styleFixed) lines.push(`- Style: ${desc.style}`);
  if (desc.doNots.length > 0) lines.push(`- Never: ${desc.doNots.join('; ')}`);
  // Acessórios são props da arte original, não identidade: só entram quando
  // a ação da cena pede, senão o mascote carrega a cesta o comercial inteiro.
  if ((desc.accessories?.length ?? 0) > 0) {
    lines.push(
      `- Removable props — include ONLY if ${propsRule} explicitly asks for them, ` +
        `otherwise the character's hands are empty: ${desc.accessories!.join(', ')}.`,
    );
  }
  if (desc.adjustments) lines.push(userAdjustmentsLine(desc.adjustments, styleFixed));
  return lines;
}
/**
 * Enquadramento por aspecto. O texto dos três aspectos históricos é o MESMO de
 * antes (sem bump de builder version); `4:5` (feed, design D12) ganha o próprio
 * texto para o caso de um formato novo vir a pedir keyframe — o F3 nunca o recebe.
 */
export function orientationForAspect(aspectRatio: string): string {
  if (aspectRatio === '9:16') return 'Vertical 9:16 composition (portrait, full-height framing)';
  if (aspectRatio === '4:5') return 'Vertical 4:5 composition (portrait feed framing)';
  if (aspectRatio === '16:9') return 'Horizontal 16:9 composition';
  return 'Square 1:1 composition';
}

export function buildKeyframePrompt(
  actionPrompt: string,
  canonicalDesc: KitCanonicalDesc | null,
  aspectRatio: string,
  identity: KeyframeIdentityOptions = {},
): string {
  const orientation = orientationForAspect(aspectRatio);
  const styleLine = styleBlockLine(identity.style);
  const lines: string[] = [
    'Commercial keyframe: the exact same mascot character from the reference images.',
    `Scene: ${actionPrompt}`,
    `${orientation}, clean supermarket/retail setting, vivid commercial lighting.`,
    identity.source === 'logo'
      ? 'No added text, numbers, price tags or watermarks anywhere in the image; the lettering ' +
        "and marks that belong to the character's own logo design stay as in the references."
      : 'No text, no numbers, no price tags, no logos, no watermark anywhere in the image.',
    ...(styleLine ? [styleLine] : []),
  ];
  if (canonicalDesc) {
    lines.push(
      ...characterSheetLines(canonicalDesc, !!styleLine, 'the scene action above', 'Traits'),
    );
  }
  return lines.join('\n');
}

/**
 * Sufixo CURTO de preservação de identidade/estilo do motor de ação — o mesmo
 * papel que "keep the character EXACTLY like this" cumpre no keyframe, na
 * forma que o PoC validou nos jobs do Kling v3
 * (scripts/poc-comerciais/jobs/*.json).
 */
export const ACTION_PRESERVATION_SUFFIX =
  'Keep exactly the same character design, colors, proportions and outfit unchanged throughout. ' +
  'One continuous, smooth, natural action. Static camera, no text or logos on screen.';

/**
 * Sufixo do AVATAR (cena falada): o Kling Avatar v2 aceita um `prompt` de
 * movimento — testado em 18/09 com o keyframe + voz reais da cena 2: o mascote
 * pegou o pacote da prateleira, mostrou à câmera e falou com a boca
 * sincronizada. Sem prompt ele fica parado (era o comportamento anterior).
 * Os lipsyncs sobre vídeo (Kling LipSync, sync-lipsync) NÃO detectam o rosto
 * de desenho — por isso a ação falada vai pelo Avatar, não por pós-processo.
 */
export const AVATAR_PRESERVATION_SUFFIX =
  'The character speaks to the camera with the mouth moving in sync with the speech, ' +
  'natural friendly gestures, face visible and facing the camera. ' +
  'Keep exactly the same character design, colors, proportions and outfit unchanged throughout. ' +
  'Static camera. Absolutely no text anywhere in the frame: no captions, no subtitles, no signs, ' +
  'no banners, no price tags, no logos (the real product package is the only allowed print).';

/** Prompt do AVATAR (cena falada com ação simples): movimento em INGLÊS + sufixo do Avatar. */
export function buildAvatarVideoPrompt(actionPromptEn: string): string {
  const action = actionPromptEn.trim().replace(/\s+/g, ' ');
  if (!action) return AVATAR_PRESERVATION_SUFFIX;
  const withStop = /[.!?]$/.test(action) ? action : `${action}.`;
  return `${withStop} ${AVATAR_PRESERVATION_SUFFIX}`;
}

/**
 * Prompt do motor de AÇÃO (cena sem fala, plano §5.2): ação em INGLÊS +
 * sufixo de preservação. O prompt vai junto com o keyframe da cena como
 * `image_url` — a identidade vem da imagem; o texto rege o movimento.
 */
export function buildActionVideoPrompt(actionPromptEn: string): string {
  const action = actionPromptEn.trim().replace(/\s+/g, ' ');
  const withStop = /[.!?]$/.test(action) ? action : `${action}.`;
  return `${withStop} ${ACTION_PRESERVATION_SUFFIX}`;
}

/**
 * Prompt do keyframe no PIPELINE V2 (ADR-001 §3.2/§3.4): descreve o ESTADO
 * INICIAL (não a sequência), respeita a área livre reservada aos elementos
 * gráficos e distingue traços permanentes de adereços removíveis. Emblemas
 * integrantes do personagem (traits/doNots da ficha) prevalecem sobre a
 * proibição genérica de logos — a regra proíbe TEXTO PROMOCIONAL, não a
 * identidade aprovada. Idioma do prompt efetivo é registrado pelo chamador.
 */
export function buildKeyframePromptV2(input: {
  initialFrame: string;
  lang: 'en' | 'pt';
  canonicalDesc: KitCanonicalDesc | null;
  aspectRatio: string;
  safeArea?: 'lower_third' | 'left' | 'right' | null;
  environmentDescription?: string | null;
  /** Nome do produto cuja FOTO REAL está entre as referências (embalagem fiel). */
  productName?: string | null;
  /** Estilo fixo do kit (bloco `STYLE_BLOCKS`); nulo = kit anterior, prompt inalterado. */
  style?: McKitStyle | null;
  /** Origem do kit — informativa aqui: o texto v2 já preserva as marcas do personagem aprovado. */
  source?: McKitSource | null;
}): string {
  const orientation = orientationForAspect(input.aspectRatio);
  const styleLine = styleBlockLine(input.style);
  const safeArea =
    input.safeArea === 'left'
      ? 'Keep the LEFT third of the frame free of the character and important objects (graphics overlay).'
      : input.safeArea === 'right'
        ? 'Keep the RIGHT third of the frame free of the character and important objects (graphics overlay).'
        : "Keep the LOWER third of the frame free of the character's face and important objects (price/caption overlay).";
  const setting = input.environmentDescription?.trim()
    ? `Setting (shared across scenes, keep consistent): ${input.environmentDescription.trim()}.`
    : 'Clean supermarket/retail setting, vivid commercial lighting.';
  const langNote =
    input.lang === 'pt'
      ? 'The scene description below is in Brazilian Portuguese; follow it literally.'
      : null;
  const lines: string[] = [
    'Commercial keyframe: the exact same mascot character from the reference images.',
    'This is the STARTING frame of a short motion — show the initial state only, not a sequence.',
    ...(langNote ? [langNote] : []),
    `Starting frame: ${input.initialFrame}`,
    `${orientation}. ${setting}`,
    safeArea,
    ...(input.productName
      ? [
          `Product reference: one of the reference images is the REAL package of "${input.productName}". ` +
            'If the character holds or presents a product, it must be EXACTLY this package: same shape, ' +
            'colors, label art and proportions, held naturally and clearly visible. Do not invent a ' +
            'different package and do not alter the label.',
        ]
      : []),
    'No ADDED promotional text, numbers, price tags or watermarks anywhere in the image (the text ' +
      'printed on the real product package stays as it is). Emblems or marks that are part of the ' +
      'approved character design stay as in the references.',
    'No store signs, posters, banners, hanging boards, shelf price tags or written labels anywhere ' +
      'in the setting; keep shelf packaging plain and simple (busy text in the background makes the ' +
      'video generator hallucinate captions).',
    ...(styleLine ? [styleLine] : []),
  ];
  const desc = input.canonicalDesc;
  if (desc) {
    lines.push(
      ...characterSheetLines(desc, !!styleLine, 'the starting frame above', 'Permanent traits'),
    );
  }
  return lines.join('\n');
}
