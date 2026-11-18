import {
  flyerProAppOutdated,
  flyerProMissingFields,
  flyerProRevisionConflict,
  flyerProSliceTooLarge,
} from './flyer-pro.errors';
import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { FLYER_PRO_SLICE_KEYS, FlyerProSliceKey, jsonBytes } from './flyer-pro-slices';

/** Os quatro campos de todo `PATCH`; o pipe pula o corpo `{}`, então o serviço os confere à mão. */
export const SAVE_REQUIRED_FIELDS = [
  'mutationId',
  'expectedRevision',
  'schemaVersion',
  'engineVersion',
] as const;

type SaveRequiredField = (typeof SAVE_REQUIRED_FIELDS)[number];

/** Os obrigatórios que o corpo não traz (ausentes ou nulos), na ordem do contrato. */
export function missingSaveFields(body: Partial<Record<SaveRequiredField, unknown>>): string[] {
  return SAVE_REQUIRED_FIELDS.filter(
    (field) => body?.[field] === undefined || body[field] === null,
  );
}

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

const sent = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * Regravação de conferência: o corpo sem `setup`, `slices` nem `items` (`import` e `enrich` ainda não existem no DTO).
 * Chave presente, mesmo com objeto vazio, faz do corpo um `PATCH` normal (A-7).
 */
export function isConferenceBody(body: { setup?: unknown; slices?: unknown; items?: unknown }) {
  return !sent(body.setup) && !sent(body.slices) && !sent(body.items);
}

/**
 * As conferências do `PATCH` antes de abrir a transação, na ordem do contrato: os obrigatórios (400) e os tamanhos
 * (422). Nenhuma toca o banco.
 */
export function assertSaveBody(
  body: Partial<Record<SaveRequiredField, unknown>> & SizedSaveBody,
): void {
  const missing = missingSaveFields(body);
  if (missing.length > 0) throw flyerProMissingFields(missing);
  const oversized = firstOversizedPart(body);
  if (oversized) throw flyerProSliceTooLarge(oversized);
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
  const template = sent(setup?.sceneId) || setup?.refreshTemplate === true;
  return { template, pageCount: template || sent(setup?.pageCount) };
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
