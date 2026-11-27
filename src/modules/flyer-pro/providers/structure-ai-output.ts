import {
  STRUCTURE_CAMPAIGN_KINDS,
  STRUCTURE_HERO_SIZES,
  type RawStructureSection,
  type RawStructureSuggestion,
} from '../domain/structure-suggestion.types';
import { StructureAiFailure } from './flyer-pro-structure-ai.port';

/**
 * A saída do modelo conferida contra o schema fechado da versão 2 (`prompts/structure-suggestion.schema.ts`): o texto
 * vazio, que não é JSON, com campo a mais (inclusive o de número de páginas ou de divisão de seção), sem campo (a saída
 * da versão 1), com o tipo errado ou com `campaign.kind` fora da lista vira `INVALID_OUTPUT`. Nenhum campo é corrigido
 * nem completado.
 */

type Json = Record<string, unknown>;

const invalid = (why: string) => new StructureAiFailure('INVALID_OUTPUT', `Saída inválida: ${why}`);

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** O objeto tem exatamente as chaves do schema (`additionalProperties: false`, todas obrigatórias). */
const hasExactKeys = (value: Json, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isSection = (value: unknown): value is RawStructureSection =>
  isRecord(value) &&
  hasExactKeys(value, ['id', 'page', 'reason', 'items', 'itemsReason']) &&
  typeof value.id === 'string' &&
  typeof value.reason === 'string' &&
  typeof value.itemsReason === 'string' &&
  (value.page === null || Number.isInteger(value.page)) &&
  (value.items === null || isTextList(value.items));

const isHero = (value: unknown): value is RawStructureSuggestion['heroes'][number] =>
  isRecord(value) &&
  hasExactKeys(value, ['item', 'size', 'reason']) &&
  typeof value.item === 'string' &&
  typeof value.reason === 'string' &&
  (STRUCTURE_HERO_SIZES as readonly unknown[]).includes(value.size);

const isUnsuggest = (value: unknown): value is RawStructureSuggestion['unsuggest'][number] =>
  isRecord(value) &&
  hasExactKeys(value, ['item', 'reason']) &&
  typeof value.item === 'string' &&
  typeof value.reason === 'string';

const isCampaign = (value: unknown): value is RawStructureSuggestion['campaign'] =>
  isRecord(value) &&
  hasExactKeys(value, ['kind', 'label']) &&
  typeof value.label === 'string' &&
  (STRUCTURE_CAMPAIGN_KINDS as readonly unknown[]).includes(value.kind);

const isListOf = <T>(value: unknown, guard: (entry: unknown) => entry is T): value is T[] =>
  Array.isArray(value) && value.every(guard);

function isSuggestion(value: unknown): value is RawStructureSuggestion {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['summary', 'campaign', 'sections', 'heroes', 'unsuggest']) &&
    typeof value.summary === 'string' &&
    isCampaign(value.campaign) &&
    isListOf(value.sections, isSection) &&
    isListOf(value.heroes, isHero) &&
    isListOf(value.unsuggest, isUnsuggest)
  );
}

export function parseStructureOutput(text: string): RawStructureSuggestion {
  if (text.trim() === '') throw invalid('resposta vazia ou incompleta');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('o texto não é JSON');
  }
  if (!isSuggestion(parsed)) throw invalid('fora do schema');
  return parsed;
}
