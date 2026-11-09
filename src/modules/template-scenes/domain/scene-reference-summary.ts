import {
  ConceptColor,
  ConceptElement,
  ReferenceConcept,
  ReferencePlace,
  ReferenceSummary,
  Removal,
} from './scene-reference.types';

/** O resumo pt-BR que o cartão e o chat mostram, a tinta do corpo (PV-R8) e o resumo em inglês do plano. Sem chamada. */

/** A tinta do corpo: o hex e o nome, em português (resumo) e em inglês (prompt). */
export interface BodyTint {
  hex: string;
  namePt: string;
  nameEn: string;
}

/** Quase branco em CIELAB (PV-R8): acima disso o corpo não tem tinta. */
const NEAR_WHITE_LIGHTNESS = 94;
const TINT_SHARE = 0.1;
const NEUTRAL_TINT: BodyTint = { hex: '#F4F1EA', namePt: 'marfim claro', nameEn: 'light ivory' };

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Luminosidade L* (CIELAB, D65) de um `#RRGGBB`. */
export function lightnessOf(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const f = y > 216 / 24389 ? Math.cbrt(y) : (24389 / 27 / 116) * y + 16 / 116;
  return 116 * f - 16;
}

/** 10% da cor misturados com branco. */
export function mixWithWhite(hex: string): string {
  const mixed = channels(hex).map((value) =>
    Math.round(TINT_SHARE * value + (1 - TINT_SHARE) * 255),
  );
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

const hasRole = (color: ConceptColor, word: string): boolean =>
  color.role.toLowerCase().includes(word);

/**
 * PV-R8: a cor com papel "body", se ela não for quase branca; senão 10% da cor do cabeçalho (ou da primeira) com
 * branco, chamada "light <nome>". Sem paleta, um marfim neutro.
 */
export function bodyTint(concept: Pick<ReferenceConcept, 'palette'>): BodyTint {
  const { palette } = concept;
  const body = palette.find((color) => hasRole(color, 'body'));
  if (body && lightnessOf(body.hex) <= NEAR_WHITE_LIGHTNESS) {
    return { hex: body.hex, namePt: body.namePt, nameEn: body.namePt };
  }
  const base = palette.find((color) => hasRole(color, 'header')) ?? palette[0];
  if (!base) return NEUTRAL_TINT;
  const hexName = base.namePt === base.hex;
  return {
    hex: mixWithWhite(base.hex),
    namePt: hexName ? 'tom claro' : `${base.namePt} claro`,
    nameEn: hexName ? 'light tint' : `light ${base.namePt}`,
  };
}

const PLACE_PT: Readonly<Record<ReferencePlace, string>> = {
  header: 'no topo',
  'top edge': 'no topo',
  'bottom edge': 'nas bordas',
  'left edge': 'nas bordas',
  'right edge': 'nas bordas',
  corners: 'nos cantos',
  'whole background': 'no fundo',
};

const usesOf = (elements: ConceptElement[]): string[] =>
  elements.map((item) => `${item.labelPt} ${PLACE_PT[item.where]}`);

/** O que fica de fora, em português: sempre a identidade e o conteúdo; seção e selo da logo só quando aparecem. */
function leftOutOf(concept: ReferenceConcept, removed: Removal[]): string[] {
  return [
    'logo, textos, preços e produtos',
    ...(concept.ignoredSections.length > 0 ? ['as seções de produto'] : []),
    ...(removed.some((item) => item.reason === 'logo_badge') ? ['o selo/medalhão da logo'] : []),
  ];
}

export function summarize(concept: ReferenceConcept, removed: Removal[]): ReferenceSummary {
  return {
    theme: concept.themePt || concept.theme,
    uses: usesOf(concept.elements),
    colors: concept.palette.map((color) => ({ hex: color.hex, name: color.namePt })),
    body: `corpo liso em ${bodyTint(concept).namePt}`,
    leftOut: leftOutOf(concept, removed),
  };
}

const CORRECT_HINT = 'Posso gerar assim? Se quiser mudar algo, use "Corrigir".';

/** A resposta fixa do chat (PV-R5: sem enfeites, o resumo diz que usa o tema e as cores). */
export function conceptReply(summary: ReferenceSummary): string {
  const colors = summary.colors.map((color) => color.name).join(', ');
  const leftOut = `Deixo de fora: ${summary.leftOut.join(', ')}.`;
  const rest = `tema ${summary.theme}; cores: ${colors}; ${summary.body}.`;
  const head =
    summary.uses.length > 0
      ? `Vou usar: ${summary.uses.join(', ')}; ${rest}`
      : `Sem enfeites marcantes: vou usar o tema e as cores. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  return `${head} ${leftOut} ${CORRECT_HINT}`;
}

/** O pedido do plano (inglês, auditoria e contexto do juiz): o conceito em uma frase. */
export function conceptEnglish(concept: ReferenceConcept): string {
  const elements = concept.elements.map((item) => `${item.element} (${item.where})`).join('; ');
  const colors = concept.palette.map((color) => color.hex).join(', ');
  return [
    `Original background template from a reference flyer concept. Theme: ${concept.theme || concept.themePt}.`,
    elements ? `Signature elements: ${elements}.` : 'No signature elements: theme and colors only.',
    colors ? `Palette: ${colors}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** O item do brief que o contexto do Diretor carrega depois da imagem ("pedido atendido"). */
export function conceptBriefText(summary: ReferenceSummary): string {
  const uses = summary.uses.length > 0 ? summary.uses.join(', ') : 'tema e cores';
  return `Conceito do encarte: ${uses}; tema ${summary.theme}`.slice(0, 300);
}
