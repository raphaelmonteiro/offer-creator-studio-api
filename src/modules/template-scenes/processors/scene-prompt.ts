import { fold } from '../../../shared/text/fold';

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
}

const cm = (value: number): string => String(value).replace('.', ',');

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

export const FIXED_RULES =
  'Regras: sem texto legível, sem letras ou números, sem logotipos, sem preços, sem produtos de marcas reais e sem pessoas identificáveis.';

/** Os itens em aberto, numa frase fixa do código (nunca texto livre do modelo). */
export function openItemsSentence(items: string[]): string {
  return ` Pedidos do cliente ainda em aberto: ${items.map((item) => cleanRequest(item).replace(/[.!]+$/, '')).join('; ')}.`;
}

/**
 * Prompt da geração (primeira, e imagem nova da D-18): o pedido literal, o formato em cm e a
 * proporção, a imagem única e contínua (D-16) e as regras fixas. Sem composição por faixas ou zonas.
 */
export function buildGeneratePrompt(input: ScenePromptInput): string {
  const ratio = (input.artWidthCm / input.artHeightCm).toFixed(2).replace('.', ',');
  return [
    'Crie a imagem de fundo de um encarte de ofertas de supermercado, para impressão.',
    `Pedido do cliente: "${cleanRequest(input.request)}".`,
    ...(input.openItems?.length ? [openItemsSentence(input.openItems).trim()] : []),
    `Formato: ${cm(input.artWidthCm)} x ${cm(input.artHeightCm)} cm (proporção largura/altura ${ratio}), imagem de ${input.widthPx} x ${input.heightPx} px, ocupando toda a área.`,
    CONTINUOUS_IMAGE_RULE,
    FIXED_RULES,
  ].join('\n');
}

const KEEP_REST =
  'Preserve todo o resto da imagem exatamente como está, sem mudar estilo, cor ou composição fora da região.';

/** Pedido que fala em texto na imagem (R32): "dizendo", "dizeres", "inscrição", "nome" e "número" também contam. */
const ASKS_FOR_TEXT =
  /\b(textos?|letras?|escrit[oa]s?|palavras?|frases?|dizendo|dizeres|inscri(?:cao|coes)|nomes?|numeros?)\b/;

/**
 * Regras fixas da edição (correção 6): sem logotipos e sem preços sempre; a regra de texto só sai se o
 * pedido fala em texto na imagem ("uma placa com letras"). Texto exato é camada, sem passar pelo modelo.
 */
export function editRules(request: string): string {
  return ASKS_FOR_TEXT.test(fold(request))
    ? 'Regras: sem logotipos e sem preços.'
    : 'Regras: sem texto legível, sem letras ou números, sem logotipos e sem preços.';
}

/** Remoção sem objeto nomeado (`object` nulo: "remove isso", "tira essa área"): só aponta a marcação. */
export const REMOVE_INSTRUCTION = 'remova o que está na área marcada e continue o fundo ao redor';

/** Remoção com objeto nomeado: a frase do cliente vale, e o fundo continua ao redor. */
export const CONTINUE_BACKGROUND = 'Continue o fundo ao redor, sem deixar marca do que saiu.';

/**
 * Prompt da edição local: a instrução literal do cliente em português, precedida de "Na área
 * marcada" (com o nome dos elementos conhecidos na região, se houver) e das frases de preservação
 * medidas no spike. Remover (correção 2): com objeto nomeado vai a frase literal do cliente mais "continue
 * o fundo ao redor"; só com pronome ("remove isso"), a instrução fixa `REMOVE_INSTRUCTION`.
 */
export function buildEditPrompt(input: {
  /** O pedido para o modelo de imagem: `imagePrompt` da intenção, ou a mensagem do cliente (D-19). */
  request: string;
  /** A mensagem original do cliente, sobre a qual valem as regras fixas (R32); sem ela, `request`. */
  original?: string;
  remove: boolean;
  /** O objeto que o cliente nomeia (D-19); `null` só com pronome ("remove isso"); ausente em planos antigos. */
  object?: string | null;
  knownElements: string[];
  /** Camada `generated` a integrar ao fundo (correção 5): o modelo a pinta no fundo, sem recebê-la. */
  integrateLayer?: string;
}): string {
  const names = input.knownElements.length > 0 ? ` (${input.knownElements.join(', ')})` : '';
  const literal = cleanRequest(input.request);
  const pointsOnly = input.remove && input.object === null;
  const instruction = pointsOnly ? REMOVE_INSTRUCTION : literal.replace(/[.!]+$/, '');
  const removal = input.remove && !pointsOnly ? ` ${CONTINUE_BACKGROUND}` : '';
  const integrate = input.integrateLayer
    ? ` Pinte "${input.integrateLayer}" integrado ao fundo, como se já fizesse parte da cena, com a mesma luz e as mesmas cores.`
    : '';
  return `Na área marcada${names}: ${instruction}.${removal}${integrate} Altere somente a área indicada pela máscara. ${KEEP_REST} ${editRules(cleanRequest(input.original ?? input.request))}`;
}

/** Prompt do ajuste geral: a imagem atual entra como referência; sem composição por faixas (D-16). */
export function buildGlobalPrompt(input: { request: string }): string {
  return [
    `Ajuste esta imagem de fundo de encarte conforme o pedido do cliente: "${cleanRequest(input.request)}".`,
    CONTINUOUS_IMAGE_RULE,
    'Regras: sem texto legível, sem letras ou números, sem logotipos e sem preços.',
  ].join('\n');
}

/** Prompt do "adicionar": o item isolado, com fundo transparente. */
export function buildTransparentPrompt(subject: string): string {
  return [
    `Crie ${cleanRequest(subject)} como um objeto isolado, centralizado, com fundo totalmente transparente.`,
    'Estilo de ilustração limpa para encarte de supermercado, sem sombra projetada no fundo.',
    'Regras: sem texto legível, sem letras ou números, sem logotipos e sem preços.',
  ].join('\n');
}

/** Campos curtos do plano do Diretor que entram no prompt; o Diretor nunca escreve o prompt (G2). */
export interface PromptPlanFields {
  what_to_change: string;
  what_to_put: string;
  inventory_keep: string[];
}

/** `instr`: o que muda e o que fica no lugar, sem pontuação final. */
export function planInstruction(plan: PromptPlanFields): string {
  const parts = [plan.what_to_change, plan.what_to_put]
    .map((part) => cleanRequest(part).replace(/[.!;]+$/, ''))
    .filter(Boolean);
  return parts.join('; ');
}

/** `mant`: o que precisa continuar como está, ou vazio. */
export function planKeepSentence(plan: PromptPlanFields): string {
  const names = plan.inventory_keep.map((name) => cleanRequest(name)).filter(Boolean);
  return names.length ? ` Mantenha como estão: ${names.join(', ')}.` : '';
}

/** O pedido do plano para o gerador: `instr`, ponto e `mant`. */
export function planRequest(plan: PromptPlanFields): string {
  return `${planInstruction(plan)}.${planKeepSentence(plan)}`;
}

const KEEP_ALL =
  'Preserve todo o resto da imagem exatamente como está, sem mudar estilo, cor ou composição';

/** Regra de texto em TODOS os casos: texto pintado é recusado antes, então não há exceção (R32 saiu). */
export const NO_TEXT_RULES =
  'Regras: sem texto legível, sem letras ou números, sem logotipos e sem preços.';

export type RedrawKind = 'global' | 'item' | 'marked';

/**
 * Prompt do redesenho da imagem inteira, sempre montado pelo código a partir dos campos do plano:
 * - `global` (composição e ajuste geral): `buildGlobalPrompt` com o plano e "Mantenha como estão";
 * - `item` (por texto): "Nesta imagem: ... Altere somente isso. Preserve...";
 * - `marked` (com marcação): "Dentro do retângulo da camada de marcação: ... O retângulo é só uma marcação...".
 * Os itens em aberto entram logo depois de `mant`. "Preserve..." é instrução ao modelo, não promessa ao cliente.
 */
export function buildRedrawPrompt(input: {
  kind: RedrawKind;
  plan: PromptPlanFields;
  openItems?: string[];
}): string {
  const { kind, plan } = input;
  const open = input.openItems?.length ? openItemsSentence(input.openItems) : '';
  const body = `${planInstruction(plan)}.${planKeepSentence(plan)}${open}`;
  if (kind === 'global') return buildGlobalPrompt({ request: body });
  if (kind === 'marked') {
    return `Dentro do retângulo da camada de marcação: ${body} Altere somente essa área. ${KEEP_ALL} fora dela. O retângulo é só uma marcação: não deixe o retângulo no resultado. ${NO_TEXT_RULES}`;
  }
  return `Nesta imagem: ${body} Altere somente isso. ${KEEP_ALL}. ${NO_TEXT_RULES}`;
}
