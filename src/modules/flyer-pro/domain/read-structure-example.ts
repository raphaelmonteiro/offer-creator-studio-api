import { FLYER_PRO_CATEGORIES } from './flyer-pro-categories';
import { categoryOfSectionId } from './structure-suggestion-rules';

/**
 * A única leitura de conteúdo de fatia que o servidor faz (A-8): a ordem que o cliente usou num encarte anterior, só para
 * compor o texto do pedido ao provedor. Leitor tolerante: o que não reconhece é pulado, nunca erro; nenhuma validação nem
 * gravação depende dele.
 */

/** A linha lida do encarte anterior (a consulta dos exemplos). `structure` é opaca: chega como veio do banco. */
export interface StructureExampleRow {
  format: string;
  pageCount: number;
  schemaVersion: number;
  structure: unknown;
}

export interface StructureExampleSection {
  /** A categoria sem o prefixo `cat:` ("Carnes"). */
  category: string;
  /** A menor página das partes do plano; `null` sem plano. */
  page: number | null;
}

export interface StructureExample {
  format: string;
  pageCount: number;
  /** As seções de categoria na ordem gravada, sem o bloco de soltos. */
  sections: StructureExampleSection[];
  /** A ordem difere da ordem das 11 categorias ou há `structure.suggestion`. */
  deliberate: boolean;
}

/** A maior versão da fatia que o leitor conhece. */
const KNOWN_SCHEMA_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `structure.sections`, quando é um vetor de objetos com `id` de texto; senão `null`. */
function sectionIdsOf(structure: Record<string, unknown>): string[] | null {
  const sections = structure.sections;
  if (!Array.isArray(sections)) return null;
  const ids = sections.map((section) => (isRecord(section) ? section.id : undefined));
  return ids.every((id): id is string => typeof id === 'string') ? ids : null;
}

/** A menor página inteira de `plan[id].parts`; seção sem entrada no plano (ou sem página) fica sem página. */
function firstPageOf(plan: unknown, sectionId: string): number | null {
  const entry = isRecord(plan) ? plan[sectionId] : undefined;
  const parts = isRecord(entry) ? entry.parts : undefined;
  if (!Array.isArray(parts)) return null;
  const pages = parts
    .map((part) => (isRecord(part) ? part.page : undefined))
    .filter((page): page is number => Number.isInteger(page) && (page as number) >= 1);
  return pages.length > 0 ? Math.min(...pages) : null;
}

/** A posição da categoria na ordem das 11; a que não é uma delas vai para o fim, na ordem em que veio. */
const rankOf = (category: string): number => {
  const index = (FLYER_PRO_CATEGORIES as readonly string[]).indexOf(category);
  return index === -1 ? FLYER_PRO_CATEGORIES.length : index;
};

function followsCategoryOrder(categories: readonly string[]): boolean {
  const sorted = [...categories].sort((a, b) => rankOf(a) - rankOf(b));
  return categories.every((category, index) => category === sorted[index]);
}

/**
 * Formato, páginas e a sequência das seções de categoria (com a primeira página de cada uma) de um encarte anterior, ou
 * `null` quando ele não serve: `schemaVersion` maior que o conhecido, `structure.sections` que não é vetor de objetos com
 * `id` de texto, ou nenhuma seção de categoria.
 */
export function readStructureExample(row: StructureExampleRow): StructureExample | null {
  if (Number(row.schemaVersion) > KNOWN_SCHEMA_VERSION || !isRecord(row.structure)) return null;
  const ids = sectionIdsOf(row.structure);
  if (ids === null) return null;
  const sections = ids
    .map((id) => ({
      category: categoryOfSectionId(id),
      page: firstPageOf(row.structure['plan'], id),
    }))
    .filter((section): section is StructureExampleSection => Boolean(section.category));
  if (sections.length === 0) return null;
  const suggested = isRecord(row.structure['suggestion']);
  return {
    format: row.format,
    pageCount: row.pageCount,
    sections,
    deliberate: suggested || !followsCategoryOrder(sections.map((section) => section.category)),
  };
}

/**
 * Os exemplos deliberados, na ordem recebida (a do mais recente para o mais antigo), até `limit`: o que o leitor aceita e
 * que mostra escolha do cliente. `limit` 0 não devolve nada.
 */
export function pickDeliberateExamples(
  rows: readonly StructureExampleRow[],
  limit: number,
): StructureExample[] {
  const picked: StructureExample[] = [];
  for (const row of rows) {
    if (picked.length >= limit) break;
    const example = readStructureExample(row);
    if (example?.deliberate) picked.push(example);
  }
  return picked;
}
