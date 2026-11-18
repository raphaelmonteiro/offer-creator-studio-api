import {
  STRUCTURE_HERO_SIZES,
  type RawStructureSuggestion,
} from '../domain/structure-suggestion.types';
import { StructureAiFailure } from './flyer-pro-structure-ai.port';

/**
 * A saída do modelo conferida contra o schema fechado (`prompts/structure-suggestion.schema.ts`): o texto vazio, que não é
 * JSON, com campo a mais, sem campo ou com o tipo errado vira `INVALID_OUTPUT`. Nenhum campo é corrigido nem completado.
 */

type Json = Record<string, unknown>;

const invalid = (why: string) => new StructureAiFailure('INVALID_OUTPUT', `Saída inválida: ${why}`);

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** O objeto tem exatamente as chaves do schema (`additionalProperties: false`, todas obrigatórias). */
const hasExactKeys = (value: Json, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const isSection = (value: unknown): value is RawStructureSuggestion['sections'][number] =>
  isRecord(value) &&
  hasExactKeys(value, ['id', 'page', 'reason']) &&
  typeof value.id === 'string' &&
  typeof value.reason === 'string' &&
  (value.page === null || Number.isInteger(value.page));

const isHero = (value: unknown): value is RawStructureSuggestion['heroes'][number] =>
  isRecord(value) &&
  hasExactKeys(value, ['item', 'size', 'reason']) &&
  typeof value.item === 'string' &&
  typeof value.reason === 'string' &&
  (STRUCTURE_HERO_SIZES as readonly unknown[]).includes(value.size);

function isSuggestion(value: unknown): value is RawStructureSuggestion {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['summary', 'sections', 'heroes']) &&
    typeof value.summary === 'string' &&
    Array.isArray(value.sections) &&
    value.sections.every(isSection) &&
    Array.isArray(value.heroes) &&
    value.heroes.every(isHero)
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
