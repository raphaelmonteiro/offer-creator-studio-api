import { EntityManager } from 'typeorm';
import { ReferenceConcept, ReferenceSummary } from '../domain/scene-reference.types';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { readOf } from '../services/scene-reference-state';

/** O que o turno da referência precisa saber do encarte: a cópia reduzida em disco e a ficha. */
export interface TurnReference {
  /** A versão `read_reference` (a própria, na leitura; a ficha usada, na geração). */
  readVersionId: string;
  /** URL do encarte reduzido; `null` se o arquivo saiu do disco. */
  assetUrl: string | null;
  /** Ficha limpa que a geração usa; `null` na leitura. */
  concept: ReferenceConcept | null;
  summary: ReferenceSummary | null;
  /** Correção do cliente e a ficha anterior, só na leitura corrigida (D-3). */
  note?: string;
  previous?: ReferenceConcept | null;
}

async function assetUrlOf(manager: EntityManager, assetId: string): Promise<string | null> {
  const asset = await manager.findOne(TemplateSceneAsset, { where: { id: assetId } });
  return asset && !asset.purgedAt ? asset.url : null;
}

/** O contexto do turno `read_reference` (a própria versão) ou do `generate` nascido de uma ficha; senão, `null`. */
export async function loadTurnReference(
  manager: EntityManager,
  version: TemplateSceneVersion,
): Promise<TurnReference | null> {
  if (version.operation === 'read_reference') {
    const read = readOf(version);
    if (!read) return null;
    const previous = read.correctionOf
      ? await manager.findOne(TemplateSceneVersion, { where: { id: read.correctionOf } })
      : null;
    return {
      readVersionId: version.id,
      assetUrl: await assetUrlOf(manager, read.assetId),
      concept: null,
      summary: null,
      note: read.note,
      previous: previous ? (readOf(previous)?.concept ?? null) : null,
    };
  }
  const readId = version.metrics?.referenceReadVersionId as string | undefined;
  if (version.operation !== 'generate' || !readId) return null;
  const readVersion = await manager.findOne(TemplateSceneVersion, { where: { id: readId } });
  const read = readVersion && readOf(readVersion);
  if (!readVersion || !read) return null;
  return {
    readVersionId: readVersion.id,
    assetUrl: await assetUrlOf(manager, read.assetId),
    concept: read.concept ?? null,
    summary: read.summary ?? null,
  };
}
