import { HttpException } from '@nestjs/common';
import type { StartEnrichmentDto } from '../dto/start-enrichment.dto';
import { QUEUES } from '../../../shared/queue/animation-queue.service';
import {
  activeJobViolation,
  ANA,
  CURSOR,
  DOC,
  jobRow,
  makeJobsService,
} from './flyer-pro-jobs.service.testutil';

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const OTHER_DOCUMENT_ITEM = '33333333-3333-4333-8333-333333333333';

const dto = (over: Partial<StartEnrichmentDto> = {}) =>
  ({ steps: ['image_match'], ...over }) as StartEnrichmentDto;

const codeOf = (error: unknown): string => (error as HttpException).getResponse()['code'];

describe('FlyerProJobsService.start (N14)', () => {
  const seventyEight = { itemIdsInDocument: [ITEM_A, ITEM_B], counts: { image_match: 78 } };

  it('Buscar fotos de 78 itens: o job nasce queued com total 78 e o primeiro lote entra na mesma transação', async () => {
    const { service, inserted, queue, manager } = makeJobsService(seventyEight);

    const view = await service.start(ANA, DOC, dto({ itemIds: null }));

    expect(view).toMatchObject({
      status: 'queued',
      steps: ['image_match'],
      total: 78,
      processed: 0,
      phase: null,
      result: {},
      error: null,
      models: null,
      costUsd: null,
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      cancelRequested: false,
      stalled: false,
      createdByUserId: ANA,
      itemIds: null,
      itemsUpdatedAt: CURSOR,
    });
    expect(inserted).toHaveLength(1);
    expect(queue.publish).toHaveBeenCalledWith(
      QUEUES.FLYER_PRO_ENRICH,
      { jobId: expect.any(String), seq: 0 },
      { manager, retryLimit: 0, expireInSeconds: 300 },
    );
    expect((queue.publish.mock.calls[0][1] as { jobId: string }).jobId).toBe(view.id);
  });

  it('o job lido traz os 22 campos do contrato e nenhum campo interno', async () => {
    const { service } = makeJobsService(seventyEight);

    const view = await service.start(ANA, DOC, dto());

    expect(Object.keys(view).sort()).toEqual(
      [
        'id', 'documentId', 'status', 'steps', 'phase', 'total', 'processed', 'itemIds', 'onlyMissing',
        'autoApply', 'result', 'error', 'models', 'costUsd', 'cancelRequested', 'stalled',
        'itemsUpdatedAt', 'createdByUserId', 'createdAt', 'startedAt', 'heartbeatAt', 'finishedAt',
      ].sort(),
    ); // prettier-ignore
    expect(Object.keys(view)).toHaveLength(22);
    for (const hidden of [
      'cursor',
      'batchSeq',
      'batchAttempts',
      'cancelRequestedAt',
      'updatedAt',
    ]) {
      expect(view).not.toHaveProperty(hidden);
    }
  });

  it('padrões dos campos opcionais: onlyMissing e autoApply true, itemIds null', async () => {
    const { service, inserted } = makeJobsService({
      itemIdsInDocument: [ITEM_A],
      counts: { categorize: 1, spellcheck: 1 },
    });

    await service.start(ANA, DOC, dto({ steps: ['categorize', 'spellcheck'] }));

    expect(inserted[0]).toMatchObject({ onlyMissing: true, autoApply: true, itemIds: null });
  });

  it('onlyMissing e autoApply false valem como vieram', async () => {
    const { service, inserted } = makeJobsService(seventyEight);

    await service.start(ANA, DOC, dto({ onlyMissing: false, autoApply: false }));

    expect(inserted[0]).toMatchObject({ onlyMissing: false, autoApply: false });
  });

  it('steps gravado na ordem fixa, qualquer que seja a enviada', async () => {
    const { service, inserted } = makeJobsService(seventyEight);

    await service.start(ANA, DOC, dto({ steps: ['image_match', 'categorize'] }));

    expect(inserted[0].steps).toEqual(['categorize', 'image_match']);
  });

  it('total somado por fase: 78 itens, três fases, 234', async () => {
    const { service } = makeJobsService({
      itemIdsInDocument: [ITEM_A],
      counts: { categorize: 78, spellcheck: 78, image_match: 78 },
    });

    const view = await service.start(
      ANA,
      DOC,
      dto({ steps: ['categorize', 'spellcheck', 'image_match'] }),
    );

    expect(view.total).toBe(234);
  });

  it('escopo com itens e nada a fazer: o job nasce queued com total 0 e o lote entra na fila', async () => {
    const { service, queue } = makeJobsService({ itemIdsInDocument: [ITEM_A], counts: {} });

    const view = await service.start(ANA, DOC, dto());

    expect(view).toMatchObject({ status: 'queued', total: 0 });
    expect(queue.publish).toHaveBeenCalledTimes(1);
  });

  describe('escopo', () => {
    it('ids misturados: só os do encarte entram no job, e o total conta só eles', async () => {
      const { service, inserted } = makeJobsService({
        itemIdsInDocument: [ITEM_A, ITEM_B],
        counts: { image_match: 2 },
      });

      const view = await service.start(
        ANA,
        DOC,
        dto({ itemIds: [ITEM_A, OTHER_DOCUMENT_ITEM, ITEM_B, ITEM_A] }),
      );

      expect(inserted[0].itemIds).toEqual([ITEM_A, ITEM_B]);
      expect(view).toMatchObject({ itemIds: [ITEM_A, ITEM_B], total: 2 });
    });

    it.each([
      ['encarte sem itens', { itemIdsInDocument: [] }, null],
      ['itemIds vazio', { itemIdsInDocument: [ITEM_A] }, []],
      ['só ids de outro encarte', { itemIdsInDocument: [ITEM_A] }, [OTHER_DOCUMENT_ITEM]],
    ])('%s: 422 FLYER_PRO_NO_ITEMS, sem job e sem lote', async (_, world, itemIds) => {
      const { service, inserted, queue } = makeJobsService(world);

      await expect(service.start(ANA, DOC, dto({ itemIds }))).rejects.toMatchObject({
        status: 422,
      });
      expect(inserted).toEqual([]);
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('o código do erro de escopo vazio é FLYER_PRO_NO_ITEMS', async () => {
      const { service } = makeJobsService({ itemIdsInDocument: [] });

      const error = await service.start(ANA, DOC, dto()).catch((e: unknown) => e);

      expect(codeOf(error)).toBe('FLYER_PRO_NO_ITEMS');
    });
  });

  describe('ordem das conferências (o 401 e o 400 de forma vêm antes, do guard e do pipe)', () => {
    it('encarte inexistente ou excluído: 404 antes de tudo, mesmo com a flag desligada', async () => {
      const { service, inserted } = makeJobsService(
        { documentLive: false, itemIdsInDocument: [] },
        { enabled: false },
      );

      const error = await service.start(ANA, DOC, dto()).catch((e: unknown) => e);

      expect(codeOf(error)).toBe('FLYER_PRO_NOT_FOUND');
      expect(inserted).toEqual([]);
    });

    it('flag desligada e encarte sem itens: 422 FLYER_PRO_ENRICHMENT_DISABLED', async () => {
      const { service, inserted, queue } = makeJobsService(
        { itemIdsInDocument: [] },
        { enabled: false },
      );

      const error = await service.start(ANA, DOC, dto()).catch((e: unknown) => e);

      expect(codeOf(error)).toBe('FLYER_PRO_ENRICHMENT_DISABLED');
      expect((error as HttpException).getResponse()['message']).toBe(
        'A busca automática está desligada neste ambiente.',
      );
      expect(inserted).toEqual([]);
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('job ativo e escopo vazio: 422 FLYER_PRO_NO_ITEMS (o escopo vem antes do job ativo)', async () => {
      const { service } = makeJobsService({
        itemIdsInDocument: [ITEM_A],
        active: jobRow({ status: 'running' }),
      });

      const error = await service.start(ANA, DOC, dto({ itemIds: [] })).catch((e: unknown) => e);

      expect(codeOf(error)).toBe('FLYER_PRO_NO_ITEMS');
    });

    it('corpo sem steps (o pipe pula o {}): 400 BAD_REQUEST, sem job', async () => {
      const { service, inserted } = makeJobsService(seventyEight);

      const error = await service
        .start(ANA, DOC, {} as StartEnrichmentDto)
        .catch((e: unknown) => e);

      expect(codeOf(error)).toBe('BAD_REQUEST');
      expect(inserted).toEqual([]);
    });
  });

  describe('um job ativo por encarte', () => {
    it('a violação do índice vira 409 com o jobId do job que nasceu primeiro, nunca 500', async () => {
      const winner = jobRow({ id: 'job-vencedor', status: 'running' });
      const { service, manager } = makeJobsService({ ...seventyEight, active: winner });
      manager.insert.mockRejectedValueOnce(activeJobViolation());

      const error = await service.start(ANA, DOC, dto()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(409);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: 'FLYER_PRO_ENRICHMENT_RUNNING',
        message: 'Já há uma busca em andamento neste encarte.',
        details: { jobId: 'job-vencedor' },
      });
    });

    it('a falha da fila desfaz a inserção (a transação aborta) e sobe como erro, sem job na resposta', async () => {
      const { service, queue } = makeJobsService(seventyEight);
      queue.publish.mockRejectedValue(new Error('Fila não inicializada'));

      await expect(service.start(ANA, DOC, dto())).rejects.toThrow('Fila não inicializada');
    });

    it('outro erro do banco não vira 409', async () => {
      const { service, manager } = makeJobsService(seventyEight);
      manager.insert.mockRejectedValueOnce(new Error('conexão perdida'));

      await expect(service.start(ANA, DOC, dto())).rejects.toThrow('conexão perdida');
    });
  });
});

describe('FlyerProJobsService.current (N15)', () => {
  it('encarte que nunca teve job: { job: null }', async () => {
    const { service } = makeJobsService();

    expect(await service.current(DOC)).toEqual({ job: null });
  });

  it('o ativo vence o mais recente', async () => {
    const running = jobRow({ id: 'ativo', status: 'running' });
    const newerDone = jobRow({ id: 'recente', status: 'done' });
    const { service } = makeJobsService({ active: running, latest: newerDone });

    expect((await service.current(DOC)).job?.id).toBe('ativo');
  });

  it('sem ativo, o mais recente, mesmo terminado', async () => {
    const { service } = makeJobsService({
      active: null,
      latest: jobRow({ id: 'hoje', status: 'done' }),
    });

    expect((await service.current(DOC)).job).toMatchObject({ id: 'hoje', status: 'done' });
  });

  it('job que falhou com o usuário fora: traz o error gravado', async () => {
    const error = { code: 'AI_PROVIDER_ERROR', phase: 'image_match', message: 'x' } as const;
    const { service } = makeJobsService({ latest: jobRow({ status: 'failed', error }) });

    expect((await service.current(DOC)).job).toMatchObject({ status: 'failed', error });
  });

  it('encarte inexistente ou excluído: 404, e não consulta job', async () => {
    const { service, manager } = makeJobsService({ documentLive: false });

    await expect(service.current(DOC)).rejects.toMatchObject({ status: 404 });
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('a leitura não grava nada e repetida dá a mesma resposta', async () => {
    const { service, manager } = makeJobsService({ latest: jobRow({ status: 'done' }) });

    const first = await service.current(DOC);
    const second = await service.current(DOC);

    expect(second).toEqual(first);
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('job com parada pedida: cancelRequested true', async () => {
    const { service } = makeJobsService({
      active: jobRow({ status: 'running', cancelRequestedAt: new Date() }),
    });

    expect((await service.current(DOC)).job?.cancelRequested).toBe(true);
  });

  describe('stalled e itemsUpdatedAt', () => {
    const NOW = new Date('2026-11-14T13:10:00.000Z');
    beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
    afterEach(() => jest.useRealTimers());

    const agoSeconds = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

    it('worker parado: job running sem batimento e com updatedAt de 181 s atrás', async () => {
      const { service } = makeJobsService({
        active: jobRow({ status: 'running', updatedAt: agoSeconds(181) }),
      });

      expect((await service.current(DOC)).job?.stalled).toBe(true);
    });

    it('batimento há 10 s: não está parado, e o carimbo dos itens vem com microssegundos', async () => {
      const { service } = makeJobsService({
        active: jobRow({
          status: 'running',
          updatedAt: agoSeconds(500),
          heartbeatAt: agoSeconds(10),
        }),
      });

      expect((await service.current(DOC)).job).toMatchObject({
        stalled: false,
        itemsUpdatedAt: '2026-11-14T13:05:40.412377Z',
      });
    });

    it('job terminado há 2 horas: stalled false', async () => {
      const { service } = makeJobsService({
        latest: jobRow({ status: 'done', updatedAt: agoSeconds(7200) }),
      });

      expect((await service.current(DOC)).job?.stalled).toBe(false);
    });
  });
});
