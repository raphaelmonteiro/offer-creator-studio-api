import {
  flyerProAppOutdated,
  flyerProBadRequest,
  flyerProMissingFields,
  flyerProRevisionConflict,
  flyerProSliceTooLarge,
} from './flyer-pro.errors';
import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { isSent, missingFields } from './flyer-pro-presence';
import { FLYER_PRO_SLICE_KEYS, FlyerProSliceKey, jsonBytes } from './flyer-pro-slices';

/** Os quatro campos de todo `PATCH`; o pipe pula o corpo `{}`, então o serviço os confere à mão. */
export const SAVE_REQUIRED_FIELDS = [
  'mutationId',
  'expectedRevision',
  'schemaVersion',
  'engineVersion',
] as const;

type SaveRequiredField = (typeof SAVE_REQUIRED_FIELDS)[number];

/** A parte do corpo que a conferência de tamanho lê. */
export interface SizedSaveBody {
  slices?: Partial<Record<FlyerProSliceKey, unknown>> | null;
  layoutSnapshot?: unknown;
}

export interface OversizedPart {
  slice: string;
  bytes: number;
  max: number;
}

/** O que se mede, na ordem da A-4: as cinco fatias, o `layoutSnapshot` e o corpo inteiro. */
function partsOf(body: SizedSaveBody): Array<[string, unknown, number]> {
  const { sliceMaxBytes, layoutSnapshotMaxBytes, patchMaxBytes } = FLYER_PRO_LIMITS;
  return [
    ...FLYER_PRO_SLICE_KEYS.map((key): [string, unknown, number] => [
      key,
      body.slices?.[key],
      sliceMaxBytes,
    ]),
    ['layoutSnapshot', body.layoutSnapshot, layoutSnapshotMaxBytes],
    ['body', body, patchMaxBytes],
  ];
}

/** A primeira parte acima do limite (o valor no limite passa), ou `null`. Mede bytes do JSON, 1 KB = 1 024 bytes. */
export function firstOversizedPart(body: SizedSaveBody): OversizedPart | null {
  for (const [slice, value, max] of partsOf(body)) {
    if (value === undefined || value === null) continue;
    const bytes = jsonBytes(value);
    if (bytes > max) return { slice, bytes, max };
  }
  return null;
}

/**
 * Regravação de conferência: o corpo sem `setup`, `slices` nem `items` (`import` e `enrich` ainda não existem no DTO).
 * Chave presente, mesmo com objeto vazio, faz do corpo um `PATCH` normal (A-7).
 */
export function isConferenceBody(body: { setup?: unknown; slices?: unknown; items?: unknown }) {
  return body.setup === undefined && body.slices === undefined && body.items === undefined;
}

/**
 * As conferências do `PATCH` antes de abrir a transação, na ordem do contrato: a forma (400: obrigatórios e ids
 * repetidos) e depois os tamanhos (422). Nenhuma toca o banco.
 */
export function assertSaveBody(
  body: Partial<Record<SaveRequiredField, unknown>> & SizedSaveBody & ItemsBody,
): void {
  const missing = missingFields(body, SAVE_REQUIRED_FIELDS);
  if (missing.length > 0) throw flyerProMissingFields(missing);
  const repeated = repeatedUpsertIds(body.items?.upsert);
  if (repeated.length > 0) {
    throw flyerProBadRequest(`Ids repetidos em items.upsert: ${repeated.join(', ')}.`);
  }
  const oversized = firstOversizedPart(body);
  if (oversized) throw flyerProSliceTooLarge(oversized);
}

interface ItemsBody {
  items?: { upsert?: Array<{ id: string }> } | null;
}

/** Os ids que aparecem mais de uma vez em `items.upsert` (forma inválida: 400, A-8). */
export function repeatedUpsertIds(upsert?: Array<{ id: string }>): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { id } of upsert ?? []) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

/** O que o `PATCH` traz de `setup` e muda a resposta: a cópia da arte (cena nova ou "Atualizar arte") e o número de páginas. */
export interface SaveResponseFields {
  /** `format`, `pageCount`, `templateSnapshot` e `templateStatus` (com o `pageCount` junto). */
  template: boolean;
  pageCount: boolean;
}

export function saveResponseFields(setup?: {
  sceneId?: string | null;
  refreshTemplate?: boolean | null;
  pageCount?: number | null;
}): SaveResponseFields {
  const template = isSent(setup?.sceneId) || setup?.refreshTemplate === true;
  return { template, pageCount: template || isSent(setup?.pageCount) };
}

interface Versions {
  schemaVersion: number;
  engineVersion: number;
}

/** 409 quando o app que enviou é mais antigo que o gravado (as versões só sobem, A-09-16); igual ou maior passa. */
export function assertAppNotOutdated(stored: Versions, received: Versions): void {
  if (
    received.schemaVersion < stored.schemaVersion ||
    received.engineVersion < stored.engineVersion
  ) {
    throw flyerProAppOutdated({
      schemaVersion: stored.schemaVersion,
      engineVersion: stored.engineVersion,
    });
  }
}

/** O 409 do conflito de revisão, com o que o diálogo mostra: a revisão, a hora e o autor da gravação atual. */
export function revisionConflictOf(stored: {
  revision: number;
  updatedAt: Date | string;
  updatedByUserId?: string | null;
}) {
  return flyerProRevisionConflict({
    revision: stored.revision,
    updatedAt: new Date(stored.updatedAt).toISOString(),
    updatedByUserId: stored.updatedByUserId ?? null,
  });
}
