import { EntityManager } from 'typeorm';
import { REFERENCE_LIMITS, ReferenceRead, ReferenceState } from '../domain/scene-reference.types';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';

/**
 * O estado da ficha do encarte, em `version.metrics.reference` da versão `read_reference` (PV-R4). A "ficha atual" da
 * cena é a última leitura da face 0. Tudo aqui roda sob o lock da cena.
 */

/** A face do encarte é sempre a 0 (`single`, a Frente do `front_back` e a Externa do jornal). */
const REFERENCE_FACE = 0;

export const readOf = (version: Pick<TemplateSceneVersion, 'metrics'>): ReferenceRead | null =>
  (version.metrics?.reference as ReferenceRead | undefined) ?? null;

/** Muda o estado (e o que mais for passado) da ficha na versão, sem salvar. */
export function patchReference(version: TemplateSceneVersion, patch: Partial<ReferenceRead>): void {
  const current = readOf(version);
  if (!current) return;
  version.metrics = { ...version.metrics, reference: { ...current, ...patch } };
}

/** A última leitura da face 0 (a ficha atual), ou `null` se a cena nunca recebeu encarte. */
export function latestRead(
  manager: EntityManager,
  sceneId: string,
): Promise<TemplateSceneVersion | null> {
  return manager.findOne(TemplateSceneVersion, {
    where: { sceneId, faceIndex: REFERENCE_FACE, operation: 'read_reference' },
    order: { number: 'DESC' },
  });
}

/** Todas as leituras do mesmo encarte (mesmo asset), da mais velha à mais nova. */
export async function readsOfAsset(
  manager: EntityManager,
  sceneId: string,
  assetId: string,
): Promise<TemplateSceneVersion[]> {
  const reads = await manager.find(TemplateSceneVersion, {
    where: { sceneId, faceIndex: REFERENCE_FACE, operation: 'read_reference' },
    order: { number: 'ASC' },
  });
  return reads.filter((read) => readOf(read)?.assetId === assetId);
}

/** Correções feitas neste encarte (D-3): cada leitura que corrige a anterior. */
export async function revisionsDone(
  manager: EntityManager,
  sceneId: string,
  assetId: string,
): Promise<number> {
  const reads = await readsOfAsset(manager, sceneId, assetId);
  return reads.filter((read) => readOf(read)?.correctionOf).length;
}

export const revisionsLeftOf = (done: number): number =>
  Math.max(0, REFERENCE_LIMITS.maxRevisions - done);

/** Ficha `proposed` que vira `discarded` (novo encarte, correção ou mensagem comum). */
export async function discardProposed(manager: EntityManager, sceneId: string): Promise<void> {
  const read = await latestRead(manager, sceneId);
  if (read && readOf(read)?.state === 'proposed') {
    patchReference(read, { state: 'discarded' });
    await manager.save(read);
  }
}

/** Versões da face 0 depois da leitura, na ordem em que nasceram. */
function versionsAfter(
  manager: EntityManager,
  sceneId: string,
  read: TemplateSceneVersion,
): Promise<TemplateSceneVersion[]> {
  return manager
    .getRepository(TemplateSceneVersion)
    .createQueryBuilder('version')
    .where('version.sceneId = :sceneId AND version.faceIndex = :face', {
      sceneId,
      face: REFERENCE_FACE,
    })
    .andWhere('version.number > :after', { after: read.number })
    .orderBy('version.number', 'ASC')
    .getMany();
}

/**
 * D-4: "Tentar de novo com o encarte" enquanto a face 0 só tem versões nascidas desta ficha (nenhuma edição,
 * restauração, camada manual nem imagem nova depois) e há uma pronta.
 */
export async function canRetryFrom(
  manager: EntityManager,
  read: TemplateSceneVersion,
): Promise<boolean> {
  if (readOf(read)?.state !== 'used') return false;
  const later = await versionsAfter(manager, read.sceneId, read);
  const born = later.filter(
    (version) =>
      version.operation === 'generate' && version.metrics?.referenceReadVersionId === read.id,
  );
  return born.length === later.length && born.some((version) => version.status === 'ready');
}

/**
 * A geração por referência parou (falha, parada ou job perdido): a ficha volta a `proposed`; na repetição (D-4) continua
 * `used`. A leitura que parou fica `failed`. Chamado pelos fechamentos `failVersion` e `cancelVersion`, sob o lock.
 */
export async function settleReferenceOnStop(
  manager: EntityManager,
  version: TemplateSceneVersion,
): Promise<void> {
  if (version.operation === 'read_reference') {
    patchReference(version, { state: 'failed' });
    return;
  }
  const readId = version.metrics?.referenceReadVersionId as string | undefined;
  if (version.operation !== 'generate' || !readId) return;
  if (version.metrics?.referenceFrom !== 'proposed') return;
  const read = await manager.findOne(TemplateSceneVersion, { where: { id: readId } });
  if (read && readOf(read)?.state === 'used') {
    patchReference(read, { state: 'proposed' as ReferenceState });
    await manager.save(read);
  }
}
