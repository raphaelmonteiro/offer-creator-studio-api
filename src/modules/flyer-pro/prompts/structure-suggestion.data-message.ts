import { findFlyerProFormat, sceneFormatIdOf } from '../domain/flyer-pro-formats';
import type { FlyerProFormat } from '../domain/flyer-pro.types';
import type { StructureExample } from '../domain/read-structure-example';
import type {
  StructureAiItem,
  StructureAiPage,
  StructureAiRequest,
  StructureAiSection,
} from '../domain/structure-ai-request';

/**
 * A mensagem "DADOS" do pedido ao modelo (anexo 11 § 3.4): o encarte, as páginas, as seções na ordem atual, os produtos e
 * os encartes anteriores do cliente. Só apelidos, nenhum UUID. O texto do usuário (nome do encarte e dos produtos) só
 * aparece depois da linha "DADOS", com quebra de linha e `|` trocados por espaço, para ele não forjar linhas da tabela.
 */

const LOOSE_TITLE = 'Produtos soltos (sempre o último)';

/** Texto do usuário numa linha só: quebra de linha e `|` viram espaço, e os espaços repetidos viram um. */
const oneLine = (text: string): string =>
  text
    .replace(/[\r\n\x85\p{Zl}\p{Zp}|]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const pagesText = (count: number) => `${count} página${count === 1 ? '' : 's'}`;

/** "folha simples 27x40" ou "folha dupla 54x40"; formato desconhecido fica só com o nome. */
function formatLabel(format: string): string {
  const spec = findFlyerProFormat(sceneFormatIdOf(format as FlyerProFormat));
  if (!spec) return format;
  return `${spec.fold === 'double' ? 'folha dupla' : 'folha simples'} ${format}`;
}

/** Centavos em reais com vírgula e duas casas, sem separador de milhar (699 vira "6,99"). */
const money = (cents: unknown): string => {
  const value = Number(cents);
  const whole = Math.floor(value / 100);
  return `${whole},${String(value % 100).padStart(2, '0')}`;
};

interface PriceText {
  price: string;
  kind: string;
}

/** O desconto do de/por em % inteiro, arredondado ("-22%"); sem texto quando o "de" não é maior que o "por" (A-9). */
function discountText(cents: unknown, fromCents: unknown): string {
  const to = Number(cents);
  const from = Number(fromCents);
  const percent = Math.round(((from - to) / from) * 100);
  return from > to && percent > 0 ? `, -${percent}%` : '';
}

/** O preço com a unidade e o tipo em português, para os cinco tipos de `FlyerProPrice`. */
function priceText(item: StructureAiItem): PriceText {
  const { price, unit } = item;
  const base = `${money(price.cents)} ${unit}`;
  switch (price.kind) {
    case 'simple':
      return { price: base, kind: 'simples' };
    case 'from_to':
      return {
        price: `${base} (de ${money(price.fromCents)}${discountText(price.cents, price.fromCents)})`,
        kind: 'de/por',
      };
    case 'second_price':
      return {
        price: `${base} (${String(price.secondLabel)} ${money(price.secondCents)})`,
        kind: 'segundo preço',
      };
    case 'per_kg_ref':
      return {
        price: `${base} (ref. ${money(price.refKgCents)} por kg)`,
        kind: 'referência por kg',
      };
    case 'multi_buy':
      return { price: `${base} (leve ${price.buy} pague ${price.pay})`, kind: 'leve e pague' };
    default:
      return { price: base, kind: String(price.kind) };
  }
}

/** A observação da página: capa, última, face externa da folha dupla de 4 páginas, cabeçalho e rodapé. */
function pageNote(page: StructureAiPage, request: StructureAiRequest): string {
  const notes: string[] = [];
  if (page.page === 1) notes.push('capa');
  if (page.page === request.pageCount) notes.push('última');
  const outer = request.format === '54x40' && request.pageCount === 4 && page.page === 4;
  if (outer) notes.push('face externa, junto da capa');
  if (page.header) notes.push('com cabeçalho');
  if (page.footer) notes.push('com rodapé');
  return notes.length > 0 ? notes.join(', ') : '-';
}

const pageLine = (page: StructureAiPage, request: StructureAiRequest) =>
  `${page.page} | ${page.capacityCells} | ${page.usedCells} | ${page.suggestedCells} | ${pageNote(page, request)}`;

/** A seção: apelido, título, itens (com a cota quando existe), células, página atual e se o usuário a fixou. */
function sectionLine(section: StructureAiSection): string {
  const items = `${section.itemAliases.length}${section.quota === undefined ? '' : ` (cota ${section.quota})`}`;
  const current = section.pages.length > 0 ? section.pages.join('+') : '-';
  const pinned = section.pinnedPage === undefined ? 'não' : 'sim';
  const title = section.category ?? LOOSE_TITLE;
  return `${section.alias} | ${title} | ${items} | ${section.cells} | ${current} | ${pinned}`;
}

/** O destaque atual: "2x1" do usuário, "sugerido 2x1" do motor ou "-". */
const heroText = (item: StructureAiItem): string => {
  if (item.hero !== null) return item.hero;
  return item.suggestedHero !== null ? `sugerido ${item.suggestedHero}` : '-';
};

function productLine(item: StructureAiItem): string {
  const { price, kind } = priceText(item);
  const photo = item.hasPhoto ? 'sim' : 'não';
  return `${item.alias} | ${item.sectionAlias} | ${oneLine(item.name)} | ${price} | ${kind} | ${photo} | ${heroText(item)}`;
}

/** "folha simples 27x40, 2 páginas: Carnes (1) > Hortifruti (1) > Bebidas"; seção sem página fica sem parênteses. */
function exampleLine(example: StructureExample, position: number): string {
  const sections = example.sections
    .map((section) =>
      section.page === null ? section.category : `${section.category} (${section.page})`,
    )
    .join(' > ');
  return `${position}) ${formatLabel(example.format)}, ${pagesText(example.pageCount)}: ${sections}`;
}

export function buildStructureDataMessage(request: StructureAiRequest): string {
  const lines = [
    'DADOS',
    `ENCARTE: ${oneLine(request.documentName)} | ${formatLabel(request.format)} | ${pagesText(request.pageCount)} | cards no nível ${request.level} de 3`,
    `PRODUTOS SEM LUGAR HOJE: ${request.unplaced}`,
    `TETO DE DESTAQUES NOVOS: ${request.maxHeroes}`,
    'PÁGINAS (página | capacidade em células | ocupadas | dessas, em sugeridos do motor | observação)',
    ...request.pages.map((page) => pageLine(page, request)),
    'SEÇÕES NA ORDEM ATUAL (id | título | itens | células | página atual | fixada)',
    ...request.sections.map(sectionLine),
    'PRODUTOS (apelido | seção | nome | preço | tipo | foto | destaque atual)',
    ...request.items.map(productLine),
  ];
  if (request.examples.length > 0) {
    lines.push(
      'ENCARTES ANTERIORES DESTE CLIENTE (ordem final das seções, com a página)',
      ...request.examples.map((example, index) => exampleLine(example, index + 1)),
    );
  }
  return lines.join('\n');
}
