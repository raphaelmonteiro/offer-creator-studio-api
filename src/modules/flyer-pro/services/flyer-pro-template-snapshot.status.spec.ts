import {
  entryInput,
  EntryInputOptions,
  SCENE_ID,
  templateRow,
} from '../domain/flyer-pro-template-entry.testutil';
import type { FlyerProFaceKey, FlyerProTemplateStatus } from '../domain/flyer-pro.types';
import { snapshotOf, snapshotServiceFor } from './flyer-pro-template-snapshot.testutil';

const frontBack = { scene: { layout: 'front_back' } } as const;
const FRESH: FlyerProTemplateStatus = {
  available: true,
  usable: true,
  missingFaces: [],
  stale: false,
  staleKind: null,
};
const GONE: FlyerProTemplateStatus = {
  available: false,
  usable: false,
  missingFaces: [],
  stale: false,
  staleKind: null,
};

/** A face `key` refeita hoje: `pictorialKey` (imagem) e/ou `fingerprint` (camada ou nome) novos. */
function changed(key: FlyerProFaceKey, change: { art?: boolean; layers?: boolean }) {
  const base = templateRow(key).source as NonNullable<ReturnType<typeof templateRow>['source']>;
  return {
    [key]: {
      source: {
        ...base,
        pictorialKey: change.art ? `novo-${key}` : base.pictorialKey,
        fingerprint: `novo-${key}`,
      },
    },
  };
}

const statusAfter = (before: EntryInputOptions, today: EntryInputOptions) =>
  snapshotServiceFor(entryInput(today)).service.statusOf(snapshotOf(entryInput(before)));

describe('FlyerProTemplateSnapshotService.statusOf', () => {
  it('cópia recém-feita: disponível, utilizável e em dia', async () => {
    expect(await statusAfter(frontBack, frontBack)).toEqual(FRESH);
  });

  it('imagem nova numa face: stale com art', async () => {
    const today = { ...frontBack, templateOverrides: changed('front', { art: true }) };
    expect(await statusAfter(frontBack, today)).toEqual({
      ...FRESH,
      stale: true,
      staleKind: 'art',
    });
  });

  it('só o nome ou só uma camada (o fingerprint muda, o pictorialKey não): stale com layers', async () => {
    const today = { ...frontBack, templateOverrides: changed('back', { layers: true }) };
    expect(await statusAfter(frontBack, today)).toEqual({
      ...FRESH,
      stale: true,
      staleKind: 'layers',
    });
  });

  it('imagem de uma face e camada da outra: art', async () => {
    const today = {
      ...frontBack,
      templateOverrides: {
        ...changed('front', { art: true }),
        ...changed('back', { layers: true }),
      },
    };
    expect(await statusAfter(frontBack, today)).toEqual({
      ...FRESH,
      stale: true,
      staleKind: 'art',
    });
  });

  it('a revision da cena sobe (mensagens no chat) sem imagem nova: stale false', async () => {
    const today = { ...frontBack, scene: { layout: 'front_back', revision: 9 } } as const;
    expect(await statusAfter(frontBack, today)).toEqual(FRESH);
  });

  it('duas cópias que só diferem no sceneRevision dão o mesmo estado', async () => {
    const input = entryInput(frontBack);
    const { service } = snapshotServiceFor(input);
    const copy = snapshotOf(input);
    const [first, second] = [
      await service.statusOf(copy),
      await service.statusOf({ ...copy, sceneRevision: 99 } as typeof copy),
    ];
    expect(second).toEqual(first);
    expect(first).toEqual(FRESH);
  });

  it('template do Verso apagado hoje: não utilizável, faltando o back, stale com art', async () => {
    const today: EntryInputOptions = { ...frontBack, faces: ['front', 'back'], ready: ['front'] };
    expect(await statusAfter(frontBack, today)).toEqual({
      available: true,
      usable: false,
      missingFaces: ['back'],
      stale: true,
      staleKind: 'art',
    });
  });

  it('face a mais hoje (a cópia tem só a Frente): stale com art', async () => {
    const copy = snapshotOf(entryInput({ ...frontBack, ready: ['front'] }));
    const { service } = snapshotServiceFor(entryInput(frontBack));
    expect(await service.statusOf(copy)).toEqual({ ...FRESH, stale: true, staleKind: 'art' });
  });

  it('54x40 de face única hoje (layout não suportado): não utilizável, sem face faltando', async () => {
    const single54 = { scene: { formatId: 'folheto-54x40', layout: 'single' } } as const;
    const copy = snapshotOf(entryInput());
    const { service } = snapshotServiceFor(entryInput(single54));
    expect(await service.statusOf(copy)).toEqual(
      expect.objectContaining({ available: true, usable: false, missingFaces: [] }),
    );
  });

  it('cena excluída: indisponível, sem erro e sem stale', async () => {
    const copy = snapshotOf(entryInput(frontBack));
    const deleted = entryInput({ scene: { layout: 'front_back', deletedAt: new Date() } });
    expect(await snapshotServiceFor(deleted).service.statusOf(copy)).toEqual(GONE);
  });

  it('cena que não existe: o mesmo estado, sem erro', async () => {
    const copy = snapshotOf(entryInput(frontBack));
    expect(await snapshotServiceFor(null).service.statusOf(copy)).toEqual(GONE);
  });

  it('cada chamada devolve um objeto novo (o chamador pode alterá-lo)', async () => {
    const copy = snapshotOf(entryInput(frontBack));
    const { service } = snapshotServiceFor(null);
    const [a, b] = [await service.statusOf(copy), await service.statusOf(copy)];
    a.missingFaces.push('front');
    expect(b.missingFaces).toEqual([]);
  });

  it('lê pelo manager de quem chama, sem abrir transação, e não grava', async () => {
    const input = entryInput(frontBack);
    const { service, reader, manager, transaction, writesCalled } = snapshotServiceFor(input);
    await service.statusOf(snapshotOf(input), manager);
    expect(transaction).not.toHaveBeenCalled();
    expect(reader.findScene).toHaveBeenCalledWith(manager, SCENE_ID);
    expect(writesCalled()).toEqual([]);
  });

  it('sem manager: numa transação REPEATABLE READ de leitura', async () => {
    const input = entryInput(frontBack);
    const { service, transaction } = snapshotServiceFor(input);
    await service.statusOf(snapshotOf(input));
    expect(transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
  });
});
