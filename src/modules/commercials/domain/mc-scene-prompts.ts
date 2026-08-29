import { KitCanonicalDesc } from './kit-prompts';

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
 */
export function buildKeyframePrompt(
  actionPrompt: string,
  canonicalDesc: KitCanonicalDesc | null,
  aspectRatio: string,
): string {
  const orientation =
    aspectRatio === '9:16'
      ? 'Vertical 9:16 composition (portrait, full-height framing)'
      : aspectRatio === '16:9'
        ? 'Horizontal 16:9 composition'
        : 'Square 1:1 composition';
  const lines: string[] = [
    'Commercial keyframe: the exact same mascot character from the reference images.',
    `Scene: ${actionPrompt}`,
    `${orientation}, clean supermarket/retail setting, vivid commercial lighting.`,
    'No text, no numbers, no price tags, no logos, no watermark anywhere in the image.',
  ];
  if (canonicalDesc) {
    lines.push('', 'Character sheet (keep the character EXACTLY like this):');
    if (canonicalDesc.traits.length > 0) lines.push(`- Traits: ${canonicalDesc.traits.join('; ')}`);
    if (canonicalDesc.colors.length > 0) lines.push(`- Colors: ${canonicalDesc.colors.join(', ')}`);
    if (canonicalDesc.style) lines.push(`- Style: ${canonicalDesc.style}`);
    if (canonicalDesc.doNots.length > 0) lines.push(`- Never: ${canonicalDesc.doNots.join('; ')}`);
    // Acessórios são props da arte original, não identidade: só entram quando
    // a ação da cena pede, senão o mascote carrega a cesta o comercial inteiro.
    if ((canonicalDesc.accessories?.length ?? 0) > 0) {
      lines.push(
        `- Removable props — include ONLY if the scene action above explicitly asks for them, ` +
          `otherwise the character's hands are empty: ${canonicalDesc.accessories!.join(', ')}.`,
      );
    }
    if (canonicalDesc.adjustments) {
      lines.push(
        `- User adjustments (highest priority, follow strictly): ${canonicalDesc.adjustments}`,
      );
    }
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
 * Prompt do motor de AÇÃO (cena sem fala, plano §5.2): ação em INGLÊS +
 * sufixo de preservação. O prompt vai junto com o keyframe da cena como
 * `image_url` — a identidade vem da imagem; o texto rege o movimento.
 */
export function buildActionVideoPrompt(actionPromptEn: string): string {
  const action = actionPromptEn.trim().replace(/\s+/g, ' ');
  const withStop = /[.!?]$/.test(action) ? action : `${action}.`;
  return `${withStop} ${ACTION_PRESERVATION_SUFFIX}`;
}
