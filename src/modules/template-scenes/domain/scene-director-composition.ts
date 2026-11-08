import { fold } from '../../../shared/text/fold';
import { DirectorPlan } from './scene-director-schema';

/**
 * Validação 5 (G4): o sistema não pede divisão, faixa ou moldura que o cliente não pediu. Os termos do
 * plano (`image.composition`, `image.change`, `image.preserve`) são conferidos contra TODAS as mensagens do
 * cliente. A conferência nunca corta frase: o chamador refaz o Diretor uma vez, com o motivo, e, se
 * persistir, pergunta ao cliente.
 */

export const COMPOSITION_GROUPS = [
  'moldura',
  'faixa',
  'cabecalho',
  'rodape',
  'borda',
  'divisao',
  'margem',
  'espaco',
] as const;
export type CompositionGroup = (typeof COMPOSITION_GROUPS)[number];

/**
 * Termos sem acento, por grupo (anexo do `design.md`), nas duas línguas: os blocos do Diretor são em inglês e a
 * mensagem do cliente em pt-BR autoriza o grupo inteiro (D-51). `edge` só conta como borda da página ou da imagem:
 * "rustic edges" descreve uma placa, não pede borda (PV-81).
 */
const GROUP_PATTERNS: Record<CompositionGroup, RegExp> = {
  moldura: /\b(?:moldura|molduras|frame|frames|framed|framing|emoldur\w*)\b/,
  faixa: /\b(?:faixa|faixas|banner|banners|band|bands|strip|strips)\b/,
  cabecalho: /\b(?:cabecalho|cabecalhos|header|topo|top band)\b/,
  rodape: /\b(?:rodape|rodapes|roda pe|footer|bottom band)\b/,
  borda:
    /\b(?:borda|bordas|beirada|beiradas|border|borders|(?:page|image|flyer) edges?|edges? of the (?:page|image|flyer))\b/,
  divisao:
    /\b(?:divisao|divisoes|divisoria|divisorias|painel|paineis|quadro|quadros|coluna|colunas|divider|dividers|panel|panels|column|columns|split|splits)\b/,
  margem: /\b(?:margem|margens|margin|margins)\b/,
  espaco:
    /\b(?:espaco livre|area livre|espaco (?:para|pra|pro|pros|pras)|free space|empty area|blank area|space for)\b/,
};

/** Cabeçalho e rodapé do cliente autorizam também borda, faixa e topo; "moldura" só autoriza a si mesma. */
const SECTION_AUTHORIZES: readonly CompositionGroup[] = ['cabecalho', 'rodape', 'borda', 'faixa'];

/** Rótulo em pt-BR de cada grupo, para a pergunta ao cliente. */
export const COMPOSITION_LABELS: Record<CompositionGroup, string> = {
  moldura: 'moldura',
  faixa: 'faixa',
  cabecalho: 'cabeçalho',
  rodape: 'rodapé',
  borda: 'borda',
  divisao: 'divisão',
  margem: 'margem',
  espaco: 'espaço livre',
};

const collapse = (text: string): string => fold(text).replace(/\s+/g, ' ');

function groupsIn(text: string): Set<CompositionGroup> {
  const folded = collapse(text);
  return new Set(COMPOSITION_GROUPS.filter((group) => GROUP_PATTERNS[group].test(folded)));
}

function authorizedGroups(clientMessages: string[]): Set<CompositionGroup> {
  const joined = clientMessages.join(' \n ');
  const said = groupsIn(joined);
  if (said.has('cabecalho') || said.has('rodape')) SECTION_AUTHORIZES.forEach((g) => said.add(g));
  // R58: "espaço" na mensagem do cliente autoriza "espaço livre" e "free space", com `pra`, `pro` ou sem preposição.
  if (/\b(?:espaco|space)\b/.test(collapse(joined))) said.add('espaco');
  return said;
}

export type CompositionCheck =
  | { ok: true }
  | { ok: false; groups: CompositionGroup[]; reason: string };

/**
 * Campos do plano que vão ao prompt de imagem, inclusive `requests` abertos. `image.region` não é composição: a
 * faixa autorizada diz onde a mudança acontece e não pede faixa nenhuma (D-51).
 */
const planText = (plan: DirectorPlan): string =>
  [
    plan.image?.composition ?? '',
    plan.image?.change ?? '',
    ...(plan.image?.preserve ?? []),
    // Pedido em aberto também chega ao prompt (linha de pedidos e instrução do "marquei"): R4.
    ...plan.requests.filter((request) => request.action === 'open').map((request) => request.text),
  ].join(' \n ');

/** Os termos de composição que o plano traz sem o cliente ter pedido. Não altera o plano. */
export function checkComposition(plan: DirectorPlan, clientMessages: string[]): CompositionCheck {
  const used = groupsIn(planText(plan));
  if (used.size === 0) return { ok: true };
  const allowed = authorizedGroups(clientMessages);
  const groups = COMPOSITION_GROUPS.filter((group) => used.has(group) && !allowed.has(group));
  if (groups.length === 0) return { ok: true };
  const names = groups.map((g) => COMPOSITION_LABELS[g]).join(', ');
  return {
    ok: false,
    groups,
    reason: `o plano pede ${names}, e o cliente não pediu; não invente divisão, faixa ou moldura`,
  };
}

/** Grupos que o cliente pede e que contradizem a frase de continuidade (D-43): moldura, faixa ou divisão. */
const SPLIT_GROUPS: readonly CompositionGroup[] = ['moldura', 'faixa', 'divisao'];

/** O pedido de divisão por verbo ou expressão ('divide em duas partes'); fora da validação 5, que só olha termos. */
const SPLIT_VERBS = /\b(?:divid\w*|duas partes|dois lados)\b/;

/**
 * Alguma mensagem do cliente pede moldura, faixa ou divisão? "Cabeçalho" e "rodapé" não contam: arranjo não é
 * divisão (D-43). Pedido do cliente prevalece sobre a frase (D-16).
 */
export function clientAsksForSplit(clientMessages: string[]): boolean {
  const joined = clientMessages.join(' \n ');
  const said = groupsIn(joined);
  return SPLIT_GROUPS.some((group) => said.has(group)) || SPLIT_VERBS.test(collapse(joined));
}
