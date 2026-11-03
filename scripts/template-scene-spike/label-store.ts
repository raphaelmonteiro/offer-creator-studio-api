import * as fs from 'fs';
import * as path from 'path';
import { emptyLabelFor, LABEL_LEGEND, labelsPath } from './labels';
import type { LabelEntry } from './labels';

/** Valores aceitos por campo, exatamente os da `_legenda` do `labels.json`. */
export const FIELD_VALUES: Record<string, string[]> = {
  edicao: ['atendeu', 'parcial', 'nao_fez_nada', 'errado'],
  costura: ['invisivel', 'visivel'],
  costura_f48: ['invisivel', 'visivel'],
  nuvem: ['intacta', 'alterada'],
  recorte: ['limpo', 'borda_dura', 'vazio'],
  buraco: ['sem_fantasma', 'fantasma'],
  borda_16: ['integrada', 'colagem'],
  borda_32: ['integrada', 'colagem'],
  borda_64: ['integrada', 'colagem'],
  global: ['aceitavel', 'sim', 'nao'],
};

export class LabelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface LabelsFile {
  _legenda?: unknown;
  [key: string]: unknown;
}

function readFile(dir: string): LabelsFile {
  const file = labelsPath(dir);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as LabelsFile) : {};
}

/** Campos válidos de uma saída: os do modelo de rótulo do seu tipo. */
export function fieldsOf(key: string): string[] {
  return Object.keys(emptyLabelFor(key));
}

/** Entrada atual de uma saída, completando campos novos com `null`. */
export function entryOf(file: LabelsFile, key: string): LabelEntry {
  const current = (file[key] ?? {}) as LabelEntry;
  return { ...emptyLabelFor(key), ...current };
}

/**
 * Grava um rótulo. Recusa chave que não está em `knownKeys`, campo que não é do tipo da saída e valor fora
 * da legenda. Escrita atômica (arquivo temporário na mesma pasta + rename); preserva a `_legenda` e as demais chaves.
 */
export function setLabel(
  dir: string,
  knownKeys: string[],
  key: string,
  field: string,
  value: string | null,
): LabelEntry {
  if (!knownKeys.includes(key)) throw new LabelError(404, `Saída desconhecida: ${key}`);
  if (!fieldsOf(key).includes(field))
    throw new LabelError(400, `Campo ${field} não existe para ${key}`);
  if (value !== null && !FIELD_VALUES[field]?.includes(value)) {
    throw new LabelError(
      400,
      `Valor "${value}" fora da legenda de ${field}: ${FIELD_VALUES[field]?.join(' | ')}`,
    );
  }
  const file = readFile(dir);
  const next: LabelsFile = {
    ...file,
    _legenda: { ...LABEL_LEGEND, ...((file._legenda as object) ?? {}) },
  };
  const entry = { ...entryOf(file, key), [field]: value };
  next[key] = entry;
  const target = labelsPath(dir);
  const tmp = path.join(dir, `.labels.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return entry;
}

export function readEntries(dir: string, keys: string[]): Record<string, LabelEntry> {
  const file = readFile(dir);
  return Object.fromEntries(keys.map((k) => [k, entryOf(file, k)]));
}

export function isComplete(entry: LabelEntry): boolean {
  return Object.values(entry).every((v) => v !== null);
}
