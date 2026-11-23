import type { EntityManager } from 'typeorm';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { assertLiveDocument, readLiveRevision } from './flyer-pro-read';

const ID = '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21';

/** O `manager` que devolve o encarte dado (ou nenhum: a leitura do ORM não traz o excluído). */
const managerWith = (document: object | null) => {
  const manager = { findOne: jest.fn().mockResolvedValue(document) };
  return manager as unknown as EntityManager & typeof manager;
};

describe('regra de encarte vivo (flyer-pro-read)', () => {
  it('assertLiveDocument lê só o id e devolve nada quando o encarte está vivo', async () => {
    const manager = managerWith({ id: ID });

    await expect(assertLiveDocument(manager, ID)).resolves.toBeUndefined();

    expect(manager.findOne).toHaveBeenCalledWith(FlyerProDocument, {
      where: { id: ID },
      select: { id: true },
    });
  });

  it('readLiveRevision lê o id e a revisão pela mesma regra e devolve a revisão', async () => {
    const manager = managerWith({ id: ID, revision: 41 });

    await expect(readLiveRevision(manager, ID)).resolves.toBe(41);

    expect(manager.findOne).toHaveBeenCalledWith(FlyerProDocument, {
      where: { id: ID },
      select: { id: true, revision: true },
    });
  });

  it('revisão 0 é uma revisão (encarte recém-criado), não "sem encarte"', async () => {
    await expect(readLiveRevision(managerWith({ id: ID, revision: 0 }), ID)).resolves.toBe(0);
  });

  it.each([
    ['assertLiveDocument', assertLiveDocument],
    ['readLiveRevision', readLiveRevision],
  ])('%s: encarte inexistente ou excluído é 404 FLYER_PRO_NOT_FOUND', async (_name, read) => {
    await expect(read(managerWith(null), ID)).rejects.toMatchObject({
      status: 404,
      response: { code: 'FLYER_PRO_NOT_FOUND', message: 'Encarte não encontrado ou excluído.' },
    });
  });
});
