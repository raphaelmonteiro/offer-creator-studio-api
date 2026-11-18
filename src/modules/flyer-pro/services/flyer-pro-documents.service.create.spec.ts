import { QueryFailedError } from 'typeorm';
import {
  flyerProTemplateIncomplete,
  flyerProTemplateNotFound,
  flyerProTemplateUnsupported,
} from '../domain/flyer-pro.errors';
import type { CreateFlyerProDocumentDto } from '../dto/create-flyer-pro-document.dto';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { documentRow, makeService, snapshotOf } from './flyer-pro-documents.service.testutil';

const DTO: CreateFlyerProDocumentDto = {
  creationKey: '5b1e0c3a-8f0e-4d7a-9a51-2f4c1d7e9b10',
  name: 'Ofertas Piccin semana 47',
  clientId: 'c2e28b36-5c8e-4fa0-9f37-7c3357ac8487',
  sceneId: '9eb30a72-aa45-41c1-9832-2733d6a39277',
  schemaVersion: 1,
  engineVersion: 3,
};

const conflict = (constraint: string, code = '23505') =>
  new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate'), { code, constraint }));

const codeOf = (status: number, code: string) => ({ status, response: { code } });

describe('FlyerProDocumentsService.create (N1)', () => {
  it('grava o encarte com o padrão do servidor, o formato da cópia e o autor nos dois campos', async () => {
    const { service, manager, snapshots } = makeService();
    const snapshot = snapshotOf('27x40');
    snapshots.build.mockResolvedValue(snapshot);

    const result = await service.create(DTO, 'user-ana');

    expect(snapshots.build).toHaveBeenCalledWith(DTO.sceneId, manager);
    expect(manager.insert).toHaveBeenCalledWith(FlyerProDocument, {
      name: DTO.name,
      clientId: DTO.clientId,
      sceneId: DTO.sceneId,
      format: '27x40',
      pageCount: 1,
      pagesFrozen: false,
      step: 'products',
      templateSnapshot: snapshot,
      schemaVersion: 1,
      engineVersion: 3,
      revision: 0,
      creationKey: DTO.creationKey,
      createdByUserId: 'user-ana',
      updatedByUserId: 'user-ana',
    });
    expect(result.created).toBe(true);
    expect(result.document.replayed).toBe(false);
  });

  it.each([
    ['27x40', 1],
    ['54x40', 2],
  ] as const)(
    'o padrão de páginas do %s é %i, escolhido pelo formato da cópia',
    async (format, pages) => {
      const { service, manager, snapshots } = makeService();
      snapshots.build.mockResolvedValue(snapshotOf(format));

      await service.create(DTO, 'u1');

      expect(manager.insert.mock.calls[0][1]).toMatchObject({ format, pageCount: pages });
    },
  );

  it('depois do commit devolve a leitura do N3 (itens vazios, cursor e estado), com replayed false', async () => {
    const { service } = makeService();

    const { document } = await service.create(DTO, 'u1');

    expect(document).toMatchObject({
      id: 'd1',
      items: [],
      revision: 0,
      enrichment: null,
      itemsCursor: '2026-11-14T13:05:40.412377Z',
      replayed: false,
    });
  });

  describe('forma', () => {
    it('corpo {} é 400 BAD_REQUEST com a lista dos campos que faltam, e nada é consultado nem gravado', async () => {
      const { service, dataSource, documents, manager, snapshots } = makeService();

      const failure = service.create({} as CreateFlyerProDocumentDto, 'u1');

      await expect(failure).rejects.toMatchObject(codeOf(400, 'BAD_REQUEST'));
      await expect(failure).rejects.toMatchObject({
        response: {
          message:
            'Campos obrigatórios ausentes: creationKey, name, clientId, sceneId, schemaVersion, engineVersion.',
        },
      });
      expect(documents.findOne).not.toHaveBeenCalled();
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(snapshots.build).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('lista só o que falta, também quando o valor vem nulo', async () => {
      const { service } = makeService();
      const body = {
        ...DTO,
        sceneId: undefined,
        name: null,
      } as unknown as CreateFlyerProDocumentDto;

      await expect(service.create(body, 'u1')).rejects.toMatchObject({
        response: { message: 'Campos obrigatórios ausentes: name, sceneId.' },
      });
    });
  });

  describe('repetição pela chave', () => {
    it('chave de encarte vivo: 200 com o estado atual e replayed true, sem conferir corpo, cliente nem template', async () => {
      const { service, documents, dataSource, manager, snapshots } = makeService();
      documents.findOne.mockResolvedValue(documentRow());
      manager.findOne.mockResolvedValue(documentRow({ name: 'Ofertas da semana', revision: 3 }));
      const other = { ...DTO, name: 'Ofertas Piccin semana 48', sceneId: 'outra-cena' };

      const result = await service.create(other, 'u1');

      expect(result.created).toBe(false);
      expect(result.document).toMatchObject({
        replayed: true,
        name: 'Ofertas da semana',
        revision: 3,
      });
      expect(documents.findOne).toHaveBeenCalledWith({
        where: { creationKey: DTO.creationKey },
        withDeleted: true,
      });
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(snapshots.build).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('a chave é conferida antes do template: cena excluída depois da criação ainda repete com 200', async () => {
      const { service, documents, snapshots } = makeService();
      documents.findOne.mockResolvedValue(documentRow());
      snapshots.build.mockRejectedValue(flyerProTemplateNotFound());

      await expect(service.create(DTO, 'u1')).resolves.toMatchObject({ created: false });
    });

    it('chave de encarte excluído: 404 FLYER_PRO_NOT_FOUND, sem criar nem restaurar', async () => {
      const { service, documents, manager, dataSource } = makeService();
      documents.findOne.mockResolvedValue(documentRow({ deletedAt: new Date() }));

      await expect(service.create(DTO, 'u1')).rejects.toMatchObject(
        codeOf(404, 'FLYER_PRO_NOT_FOUND'),
      );

      expect(manager.insert).not.toHaveBeenCalled();
      expect(documents.update).not.toHaveBeenCalled();
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('recusas', () => {
    it('cliente inexistente: 404 CLIENT_NOT_FOUND com o texto de sempre, sem gravar', async () => {
      const { service, dataSource, manager, snapshots } = makeService();
      dataSource.query.mockResolvedValue([]);

      await expect(service.create(DTO, 'u1')).rejects.toMatchObject({
        status: 404,
        response: { code: 'CLIENT_NOT_FOUND', message: 'Cliente não encontrado' },
      });

      expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining('FROM clients'), [
        DTO.clientId,
      ]);
      expect(snapshots.build).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('cliente e cena inexistentes juntos: vale o CLIENT_NOT_FOUND (o cliente vem antes do template)', async () => {
      const { service, dataSource, snapshots } = makeService();
      dataSource.query.mockResolvedValue([]);
      snapshots.build.mockRejectedValue(flyerProTemplateNotFound());

      await expect(service.create(DTO, 'u1')).rejects.toMatchObject(
        codeOf(404, 'CLIENT_NOT_FOUND'),
      );
    });

    it.each([
      ['FLYER_PRO_TEMPLATE_NOT_FOUND', 404, flyerProTemplateNotFound(), undefined],
      [
        'FLYER_PRO_TEMPLATE_UNSUPPORTED',
        422,
        flyerProTemplateUnsupported({
          reason: 'FORMAT',
          formatId: 'folheto-20x27',
          layout: 'single',
        }),
        { reason: 'FORMAT', formatId: 'folheto-20x27', layout: 'single' },
      ],
      [
        'FLYER_PRO_TEMPLATE_INCOMPLETE',
        422,
        flyerProTemplateIncomplete(['back']),
        { missingFaces: ['back'] },
      ],
    ])(
      'o erro do montador %s passa como veio, e nada é gravado',
      async (code, status, error, details) => {
        const { service, manager, snapshots } = makeService();
        snapshots.build.mockRejectedValue(error);

        await expect(service.create(DTO, 'u1')).rejects.toMatchObject({
          status,
          response: { code, ...(details ? { details } : {}) },
        });

        expect(manager.insert).not.toHaveBeenCalled();
      },
    );
  });

  describe('corrida de duas criações com a mesma chave (23505)', () => {
    it('o 23505 da chave única relê pela chave, fora da transação, e responde 200 com replayed true', async () => {
      const { service, documents, manager, dataSource } = makeService();
      manager.insert.mockRejectedValue(conflict('UQ_flyer_pro_documents_creation_key'));
      documents.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(documentRow({ id: 'winner' }));
      manager.findOne.mockResolvedValue(documentRow({ id: 'winner' }));

      const result = await service.create(DTO, 'u1');

      expect(result.created).toBe(false);
      expect(result.document).toMatchObject({ id: 'winner', replayed: true });
      expect(documents.findOne).toHaveBeenLastCalledWith({
        where: { creationKey: DTO.creationKey },
      });
      const transactions = dataSource.transaction.mock.calls.filter(
        ([first]: unknown[]) => typeof first === 'function',
      );
      expect(transactions).toHaveLength(1);
    });

    it('o vencedor excluído no meio: 404 FLYER_PRO_NOT_FOUND', async () => {
      const { service, documents, manager } = makeService();
      manager.insert.mockRejectedValue(conflict('UQ_flyer_pro_documents_creation_key'));
      documents.findOne.mockResolvedValue(null);

      await expect(service.create(DTO, 'u1')).rejects.toMatchObject(
        codeOf(404, 'FLYER_PRO_NOT_FOUND'),
      );
    });

    it.each([
      ['23505 de outra restrição', conflict('UQ_outra')],
      ['23503 (FK)', conflict('FK_flyer_pro_documents_client', '23503')],
      ['erro qualquer', new Error('banco caiu')],
    ])('%s segue como erro, sem virar repetição', async (_name, error) => {
      const { service, manager } = makeService();
      manager.insert.mockRejectedValue(error);

      await expect(service.create(DTO, 'u1')).rejects.toBe(error);
    });
  });
});
