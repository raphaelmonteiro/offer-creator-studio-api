import { clientAsksForSplit } from '../domain/scene-director-composition';
import { DirectorImage } from '../domain/scene-director-schema';
import { findSceneFormat } from '../domain/scene-formats';
import { zoneBands } from '../domain/scene-zone-bands';

export interface ScenePromptInput {
  /** Pedido literal do cliente, em português. */
  request: string;
  /**
   * Itens do que o cliente pediu ainda em aberto. Só a imagem nova passa isto: a primeira imagem da cena nunca,
   * porque o prompt julgado excelente pelo dono (D-38) não pode mudar.
   */
  openItems?: string[];
  artWidthCm: number;
  artHeightCm: number;
  widthPx: number;
  heightPx: number;
  /** Formato da cena e mensagens do cliente: decidem a frase de continuidade (D-43). */
  formatId?: string;
  clientMessages?: string[];
  /** Linhas de `exact_text` (D-52): trocam só a linha `Regras:` pelo texto exato, copiado letra por letra. */
  exactText?: string[];
}

const cm = (value: number): string => String(value).replace('.', ',');
const cmEn = (value: number): string => String(value);

const isControl = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
};

/** Tira caracteres de controle e espaços repetidos do pedido (o texto continua literal). */
function cleanRequest(request: string): string {
  return [...request]
    .map((char) => (isControl(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** D-16: a composição só entra se o cliente pedir; o resto é uma imagem única e contínua. */
export const CONTINUOUS_IMAGE_RULE =
  'Salvo se o pedido acima disser outra coisa, a imagem é única e contínua, sem divisões, faixas ou molduras.';

/** D-43: só o formato alto, onde a emenda apareceu (3 de 7 sem a frase, 0 de 6 com ela). Texto literal do dono. */
export const CONTINUITY_PHRASE =
  'A cena é um único ambiente contínuo do topo à base: um só horizonte, um só chão, e nenhum objeto ou grupo apoiado em ilha, faixa ou pedaço de terreno separado.';

/** Formatos que levam a frase de continuidade. `folheto-27x40` fica de fora (ponto de atenção da passada 3.3). */
export const CONTINUITY_FORMAT_IDS: readonly string[] = ['folheto-27x54'];

/** O prompt de imagem traz a frase? No formato alto, e não quando o cliente pede moldura, faixa ou divisão. */
export function continuityApplies(
  formatId: string | undefined,
  clientMessages: string[] = [],
): boolean {
  return (
    formatId !== undefined &&
    CONTINUITY_FORMAT_IDS.includes(formatId) &&
    !clientAsksForSplit(clientMessages)
  );
}

export const FIXED_RULES =
  'Regras: sem texto legível, sem letras ou números, sem logotipos, sem preços, sem produtos de marcas reais e sem pessoas identificáveis.';

/** D-52: com texto pedido, só a linha `Regras:` muda; o resto do prompt testado fica como está. */
export function exactTextRules(lines: string[]): string {
  const quoted = lines.map((line) => `“${cleanRequest(line)}”`).join(' / ');
  return `Regras: o único texto da imagem é este, copiado letra por letra, com os mesmos acentos, cedilha, maiúsculas, pontuação e formato de preço: ${quoted}; nenhum outro texto, sem logotipos, sem produtos de marcas reais e sem pessoas identificáveis.`;
}

/** Os itens em aberto, numa frase fixa do código (nunca texto livre do modelo). */
export function openItemsSentence(items: string[]): string {
  return ` Pedidos do cliente ainda em aberto: ${items.map((item) => cleanRequest(item).replace(/[.!]+$/, '')).join('; ')}.`;
}

/**
 * Prompt da geração (primeira imagem e imagem nova, D-52): o pedido literal, o formato em cm e a proporção, a
 * imagem única e contínua (D-16) e as regras fixas, como o prompt que o dono julgou excelente (D-38). Com texto
 * pedido, só a linha `Regras:` muda.
 */
export function buildGeneratePrompt(input: ScenePromptInput): string {
  const ratio = (input.artWidthCm / input.artHeightCm).toFixed(2).replace('.', ',');
  return [
    'Crie a imagem de fundo de um encarte de ofertas de supermercado, para impressão.',
    `Pedido do cliente: "${cleanRequest(input.request)}".`,
    ...(input.openItems?.length ? [openItemsSentence(input.openItems).trim()] : []),
    `Formato: ${cm(input.artWidthCm)} x ${cm(input.artHeightCm)} cm (proporção largura/altura ${ratio}), imagem de ${input.widthPx} x ${input.heightPx} px, ocupando toda a área.`,
    CONTINUOUS_IMAGE_RULE,
    ...(continuityApplies(input.formatId, input.clientMessages) ? [CONTINUITY_PHRASE] : []),
    input.exactText?.length ? exactTextRules(input.exactText) : FIXED_RULES,
  ].join('\n');
}

/** O pedido do plano para o gerador da imagem nova: a mudança em uma linha, com ponto final. */
export function planRequest(plan: { image?: Pick<DirectorImage, 'change'> | null }): string {
  return `${cleanRequest(plan.image?.change ?? '').replace(/[.!;]+$/, '')}.`;
}

/** D-43, em inglês, no fim da composição das edições (a tradução da frase de `CONTINUITY_PHRASE`). */
export const CONTINUITY_PHRASE_EN =
  'The scene is one continuous environment from top to bottom: a single horizon, a single ground, and no object or group resting on an island, strip or separate piece of terrain.';

/** Uma linha do texto exato que o juiz leu diferente do pedido, para a refação (D-51). */
export interface TextCorrection {
  asked: string;
  read: string;
}

export interface EditPromptInput {
  image: DirectorImage;
  /** `pedido_composicao` é o único turno que leva a frase de continuidade (D-43). */
  composition: boolean;
  /** A mensagem trouxe marcação: ação e região mudam. */
  marked: boolean;
  formatId: string;
  clientMessages: string[];
  /** Tamanho nativo da master enviada, em px. */
  widthPx: number;
  heightPx: number;
  /** Linhas lidas diferente do pedido, na refação única. */
  corrections?: TextCorrection[];
}

const sentence = (text: string): string => {
  const clean = cleanRequest(text);
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
};

/** Faixas de `computeSceneZones` em px sobre o tamanho nativo: o limite fica dentro da faixa pedida. */
function regionText(input: EditPromptInput): string {
  const { side } = input.image.region;
  // A marcação vale (a mensagem pode citar outro lugar): com `markup` a região é sempre a área contornada.
  const zone = input.marked ? 'marked' : input.image.region.zone;
  const on = side ? ` on the ${side} side` : '';
  const format = findSceneFormat(input.formatId);
  const { heightPx: H } = input;
  if (zone === 'marked') return `Make the change only inside the outlined area${on}.`;
  if (zone === 'whole' || !format) return 'The change may affect the whole image.';
  const bands = zoneBands(format, H);
  const printCm = cmEn(format.printHeightCm);
  if (zone === 'footer') {
    return `Make the change only inside the footer band${on}: the lowest ${cmEn(format.footerCm)} cm of the ${printCm} cm page (the bottom ${bands.footerPct}% of the image height, y ≥ ${bands.footerStart} of ${H} px), entirely within it, without extending up into the central product area.`;
  }
  if (zone === 'header') {
    return `Make the change only inside the header band${on}: the top ${cmEn(format.headerCm)} cm of the ${printCm} cm page (the top ${bands.headerPct}% of the image height, y < ${bands.headerEnd} of ${H} px), entirely within it, without extending down into the central product area.`;
  }
  return `Make the change only inside the central product area${on}, between y = ${bands.headerEnd} px and y = ${bands.footerStart} px of ${H} px.`;
}

/** Bloco 8 (validação 4d): texto exato, com a linha de correção da refação, ou a regra de "sem texto". */
export function textBlock(lines: string[], corrections: TextCorrection[] = []): string {
  if (lines.length === 0) return 'No text, no letters, no numbers, no logo, no watermark.';
  const numbered = lines.map((line, index) => `Line ${index + 1}: “${cleanRequest(line)}”`);
  const fixes = corrections.map((fix) =>
    fix.read
      ? `A previous attempt rendered the text as “${cleanRequest(fix.read)}”. It must read exactly “${cleanRequest(fix.asked)}”.`
      : `A previous attempt did not show the text. It must read exactly “${cleanRequest(fix.asked)}”.`,
  );
  return [
    ...fixes,
    'Put this exact Portuguese text, copied character by character, with the same accents, cedilla, uppercase and lowercase letters, punctuation and currency format:',
    ...numbered,
    'Never invent or add text, prices or logos. No other text, no logo, no watermark.',
  ].join('\n');
}

/**
 * Prompt da edição em oito blocos, em ordem fixa (D-51): ação, formato e uso, composição, estilo, mudança desta
 * rodada, região com as medidas do formato, preservação e texto. O Diretor escreve composição, estilo, mudança e
 * preservação; o código escreve o resto. Sem a linha de pedidos em aberto (D-54).
 * "Preserve..." é instrução ao modelo, não promessa ao cliente.
 */
export function buildEditPrompt(input: EditPromptInput): string {
  const { image } = input;
  const action = input.marked
    ? 'Edit the provided image. The red outline on the markup layer marks the area to change; it is only a guide, do not draw it.'
    : 'Edit the provided image.';
  const format = findSceneFormat(input.formatId);
  const sizeCm = format ? `${cmEn(format.artWidthCm)} x ${cmEn(format.artHeightCm)} cm, ` : '';
  const orientation = input.heightPx >= input.widthPx ? 'portrait' : 'landscape';
  const composition = [
    image.composition ? sentence(image.composition) : '',
    input.composition && continuityApplies(input.formatId, input.clientMessages)
      ? CONTINUITY_PHRASE_EN
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const keep = image.preserve
    .map((item) => cleanRequest(item).replace(/[.;]+$/, ''))
    .filter(Boolean);
  return [
    action,
    `This is the background of a printed supermarket offer flyer, ${sizeCm}${input.widthPx} x ${input.heightPx} px, ${orientation}.`,
    composition,
    image.style ? sentence(image.style) : '',
    `Make exactly one change: ${sentence(image.change)}`,
    regionText(input),
    `${keep.length ? `Preserve: ${keep.join('; ')}. ` : ''}Do not change or remove any other element.`,
    textBlock(image.exact_text, input.corrections),
  ]
    .filter(Boolean)
    .join('\n');
}
