import { clientAsksForSplit } from '../domain/scene-director-composition';
import { DirectorImage } from '../domain/scene-director-schema';
import { backPreservationSentence, effectiveZone, FaceKey } from '../domain/scene-faces';
import { computeSceneZones, findSceneFormat } from '../domain/scene-formats';
import { isTabloidFace } from '../domain/scene-tabloid';
import { tabloidPreservationSentence, tabloidRegionText } from '../domain/scene-tabloid-prompts';
import { SceneZones } from '../domain/scene.types';
import { zoneBands } from '../domain/scene-zone-bands';
import { cleanRequest } from '../domain/scene-clean-text';

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
  /** Linhas que o juiz leu diferente do pedido: a refação acrescenta a correção à linha `Regras:`. */
  corrections?: TextCorrection[];
}

const cm = (value: number): string => String(value).replace('.', ',');
const cmEn = (value: number): string => String(value);

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
export function exactTextRules(lines: string[], corrections: TextCorrection[] = []): string {
  const quoted = lines.map((line) => `“${cleanRequest(line)}”`).join(' / ');
  const fixes = corrections
    .map((fix) =>
      fix.read
        ? ` Uma tentativa anterior escreveu “${cleanRequest(fix.read)}”; o certo é exatamente “${cleanRequest(fix.asked)}”.`
        : ` Uma tentativa anterior não mostrou o texto; ele deve ser exatamente “${cleanRequest(fix.asked)}”.`,
    )
    .join('');
  return `Regras: o único texto da imagem é este, copiado letra por letra, com os mesmos acentos, cedilha, maiúsculas, pontuação e formato de preço: ${quoted}; nenhum outro texto, sem logotipos, sem produtos de marcas reais e sem pessoas identificáveis.${fixes}`;
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
    input.exactText?.length ? exactTextRules(input.exactText, input.corrections) : FIXED_RULES,
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
  /** Zonas da face; sem elas, as do formato. A que a face não tem vale como miolo (PV-9). */
  zones?: SceneZones;
  /** No verso e no jornal, o prompt termina com a frase de preservação da face (PV-9, PV-T7). */
  faceKey?: FaceKey;
  /** Texto já pintado na versão atual que esta rodada não substitui: é mantido como está (D-56, 4d). */
  keepText?: string[];
}

const sentence = (text: string): string => {
  const clean = cleanRequest(text);
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
};

/** Faixas das zonas da face em px sobre o tamanho nativo: o limite fica dentro da faixa pedida. */
function regionText(input: EditPromptInput): string {
  const { side } = input.image.region;
  const format = findSceneFormat(input.formatId);
  const zones = input.zones ?? (format ? computeSceneZones(format) : undefined);
  // A marcação vale (a mensagem pode citar outro lugar): com `markup` a região é sempre a área contornada.
  const requested = input.marked ? 'marked' : input.image.region.zone;
  const zone = zones ? effectiveZone(requested, zones) : requested;
  const on = side ? ` on the ${side} side` : '';
  const { heightPx: H } = input;
  if (zone === 'marked') return `Make the change only inside the outlined area${on}.`;
  if (zone === 'whole' || !format || !zones) return 'The change may affect the whole image.';
  if (isTabloidFace(input.faceKey)) {
    // Jornal (PV-T3): a região em px com a meia largura; `center` vale como sem lado.
    return `Make the change ${tabloidRegionText(input.faceKey, {
      format,
      zones,
      widthPx: input.widthPx,
      heightPx: H,
      zone: zone as 'header' | 'footer' | 'body',
      side: side ?? null,
    })}`;
  }
  const bands = zoneBands(zones, H);
  const printCm = cmEn(format.printHeightCm);
  if (zone === 'footer') {
    return `Make the change only inside the footer band${on}: the lowest ${cmEn(format.footerCm)} cm of the ${printCm} cm page (the bottom ${bands.footerPct}% of the image height, y ≥ ${bands.footerStart} of ${H} px; the band is about ${H - bands.footerStart} px tall), sized to fit entirely within it, without extending up into the central product area.`;
  }
  if (zone === 'header') {
    return `Make the change only inside the header band${on}: the top ${cmEn(format.headerCm)} cm of the ${printCm} cm page (the top ${bands.headerPct}% of the image height, y < ${bands.headerEnd} of ${H} px; the band is about ${bands.headerEnd} px tall), sized to fit entirely within it, without extending down into the central product area.`;
  }
  return `Make the change only inside the central product area${on}, between y = ${bands.headerEnd} px and y = ${bands.footerStart} px of ${H} px.`;
}

export const correctionLines = (corrections: TextCorrection[]): string[] =>
  corrections.map((fix) =>
    fix.read
      ? `A previous attempt rendered the text as “${cleanRequest(fix.read)}”. It must read exactly “${cleanRequest(fix.asked)}”.`
      : `A previous attempt did not show the text. It must read exactly “${cleanRequest(fix.asked)}”.`,
  );

/**
 * Sem texto novo, mas com texto já pintado e conferido na versão atual (D-56): o bloco manda mantê-lo como está, e não
 * "No text", que apagaria a placa (PV-82).
 */
function keepPaintedBlock(painted: string[], corrections: TextCorrection[]): string {
  const numbered = painted.map((line, index) => `Line ${index + 1}: “${cleanRequest(line)}”`);
  return [
    ...correctionLines(corrections),
    'Keep the text already painted on the image exactly as it is, copied character by character, with the same accents, cedilla, uppercase and lowercase letters, punctuation and currency format:',
    ...numbered,
    'Never invent or add text, prices or logos. No other text, no logo, no watermark.',
  ].join('\n');
}

const KEEP_IN_PLACE =
  'Keep the text already painted on the image exactly as it is, in the same place:';

/**
 * Bloco 8 (validação 4d): texto exato da rodada com a linha de correção da refação, o texto a manter (PV-82, R65) e a
 * regra de "sem texto". Nenhum caso com texto termina sem "No other text".
 */
export function textBlock(
  lines: string[],
  corrections: TextCorrection[] = [],
  keep: string[] = [],
): string {
  if (lines.length === 0 && keep.length > 0) return keepPaintedBlock(keep, corrections);
  if (lines.length === 0) return 'No text, no letters, no numbers, no logo, no watermark.';
  const numbered = lines.map((line, index) => `Line ${index + 1}: “${cleanRequest(line)}”`);
  const kept = keep.map((line) => `“${cleanRequest(line)}”`);
  return [
    ...correctionLines(corrections),
    'Put this exact Portuguese text, copied character by character, with the same accents, cedilla, uppercase and lowercase letters, punctuation and currency format:',
    ...numbered,
    ...(kept.length ? [KEEP_IN_PLACE, ...kept] : []),
    'Never invent or add text, prices or logos. No other text, no logo, no watermark.',
  ].join('\n');
}

/**
 * Frase de preservação da face (PV-9, PV-T7): a do verso, da Externa ou da Interna, no fim do prompt, e sem a parte
 * "sem texto" se há texto. As outras faces não têm.
 */
function faceSentence(input: EditPromptInput): string {
  const format = findSceneFormat(input.formatId);
  const { faceKey } = input;
  if (!format || !input.zones || (faceKey !== 'back' && !isTabloidFace(faceKey))) return '';
  const sentenceInput = {
    format,
    widthPx: input.widthPx,
    heightPx: input.heightPx,
    zones: input.zones,
    withClientText: input.image.exact_text.length > 0 || (input.keepText?.length ?? 0) > 0,
  };
  return isTabloidFace(faceKey)
    ? tabloidPreservationSentence(faceKey, sentenceInput)
    : backPreservationSentence(sentenceInput);
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
    textBlock(image.exact_text, input.corrections, input.keepText),
    faceSentence(input),
  ]
    .filter(Boolean)
    .join('\n');
}
