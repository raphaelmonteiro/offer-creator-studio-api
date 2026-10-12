/**
 * Vocabulário da identidade do kit (change video-formatos-personagem, D4/D5):
 * de onde o personagem nasce, em que estilo é renderizado e como a identidade
 * é fixada. Função pura, sem Nest/IO — fica fora de mc-types.ts porque é
 * vocabulário do KIT, não do roteiro/projeto.
 */

/** Origem do personagem: mascote enviado ou logo da marca (spec "Origem do personagem"). */
export const MC_KIT_SOURCES = ['mascot', 'logo'] as const;
export type McKitSource = (typeof MC_KIT_SOURCES)[number];

/** Estilo de render escolhido na criação; nulo em kits anteriores (exibido como "herdado"). */
export const MC_KIT_STYLES = ['cartoon_2d', '3d_render', 'realistic'] as const;
export type McKitStyle = (typeof MC_KIT_STYLES)[number];

/**
 * Como a identidade do kit foi fixada: `generated` (referências geradas a
 * partir do mascote ou de um candidato de mascotização) ou `logo_as_is`
 * (pixels originais do logo — só vale com `source = 'logo'`, CHECK no banco).
 */
export const MC_KIT_IDENTITY_MODES = ['generated', 'logo_as_is'] as const;
export type McKitIdentityMode = (typeof MC_KIT_IDENTITY_MODES)[number];

export function isMcKitSource(value: unknown): value is McKitSource {
  return typeof value === 'string' && (MC_KIT_SOURCES as readonly string[]).includes(value);
}

export function isMcKitStyle(value: unknown): value is McKitStyle {
  return typeof value === 'string' && (MC_KIT_STYLES as readonly string[]).includes(value);
}

/**
 * Blocos FIXOS de estilo (D5): substituem o hack de escrever o estilo em
 * `adjustments`. Entram em todo prompt de referência do kit e de keyframe e
 * fazem parte do hash — mudar o texto aqui muda o resultado, então versionar
 * com bump do builder correspondente. Em inglês porque os motores de imagem
 * leem inglês; nunca nomeiam estúdios ou obras.
 */
export const STYLE_BLOCKS: Record<McKitStyle, string> = {
  cartoon_2d:
    'Flat 2D vector cartoon illustration: clean uniform outlines, flat solid color fills, ' +
    'minimal cel shading, no 3D volume, no photographic texture.',
  '3d_render':
    '3D animated-feature style render: full volumetric forms, soft studio lighting with ' +
    'gentle subsurface scattering, matte materials, subtle ambient occlusion, no flat 2D outlines.',
  realistic:
    'Photorealistic rendering: physically plausible materials, textures and lighting, natural ' +
    "shadows and reflections, while keeping the character's exact design, proportions, colors " +
    'and features unchanged.',
};

/** Linha do prompt que fixa o estilo — a mesma em kit e keyframe, para o hash e o snapshot casarem. */
export function styleBlockLine(style: McKitStyle | null | undefined): string | null {
  if (!style || !isMcKitStyle(style)) return null;
  return (
    'Rendering style (FIXED for this character — takes precedence over any other style ' +
    `instruction): ${STYLE_BLOCKS[style]}`
  );
}
