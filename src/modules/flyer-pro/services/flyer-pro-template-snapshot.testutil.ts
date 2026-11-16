import type { DataSource, EntityManager } from 'typeorm';
import type { TemplateEntryInput } from '../domain/flyer-pro-template-entry';
import { FlyerProSceneReader } from './flyer-pro-scene.reader';
import { FlyerProTemplateSnapshotService } from './flyer-pro-template-snapshot.service';

/** Os métodos de escrita do `EntityManager`: nenhum deles pode ser chamado pela montagem nem pelo estado da cópia. */
const WRITES = ['save', 'insert', 'update', 'delete', 'remove', 'softDelete', 'upsert'] as const;

/** O que o spec do montador monta: o serviço sobre um leitor simulado, e o que ele tocou. */
export function snapshotServiceFor(input: TemplateEntryInput | null) {
  const writes = Object.fromEntries(WRITES.map((name) => [name, jest.fn()]));
  const manager = { query: jest.fn(), ...writes } as unknown as EntityManager;
  const transaction = jest.fn((_level: string, work: (m: EntityManager) => unknown) =>
    work(manager),
  );
  const reader = {
    findScene: jest.fn().mockResolvedValue(input?.scene ?? null),
    faceRows: jest.fn().mockResolvedValue(input?.faces ?? []),
    templateRows: jest.fn().mockResolvedValue([...(input?.templates.values() ?? [])]),
  };
  const service = new FlyerProTemplateSnapshotService(
    { transaction } as unknown as DataSource,
    reader as unknown as FlyerProSceneReader,
  );
  const writesCalled = () =>
    WRITES.filter((name) => (writes[name] as jest.Mock).mock.calls.length > 0);
  return { service, reader, manager, transaction, writesCalled };
}

/** Status e corpo de um erro do montador, para comparar com o contrato. */
export async function failureOf(
  work: Promise<unknown>,
): Promise<{ status: number; body: unknown }> {
  try {
    await work;
  } catch (error) {
    const http = error as { getStatus(): number; getResponse(): unknown };
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error('a montagem não recusou');
}
