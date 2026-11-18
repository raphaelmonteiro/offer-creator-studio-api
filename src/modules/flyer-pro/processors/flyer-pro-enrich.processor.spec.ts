import { Logger } from '@nestjs/common';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { FlyerProEnrichConfig, readEnrichConfig } from '../config/flyer-pro-enrich.config';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { jobRow } from '../services/flyer-pro-jobs.service.testutil';
import {
  classifyBatchError,
  FlyerProEnrichProcessor,
  ProviderDeadlineError,
} from './flyer-pro-enrich.processor';
import type { UnitPlan } from './flyer-pro-enrich.types';

const ITEM = {
  id: 'i1', position: 0, name: 'ABACATE', sourceName: null, category: null, categorySource: null,
  categoryReview: null, spellReview: null, unit: 'kg', ean: null, imported: null,
  imageStatus: 'none', imageOrigin: null, imageReview: null,
}; // prettier-ignore

/** O processador com banco, comitador e porta simulados: o que se confere é o batimento, o prazo, o log e o "nunca lança". */
function build(
  over: { port?: object; config?: Partial<FlyerProEnrichConfig>; items?: object[] } = {},
) {
  const claimed = jobRow({ status: 'running', batchSeq: 4, phase: 'image_match', total: 16 });
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('RETURNING *')) return [[claimed]];
    if (sql.includes('"deletedAt" FROM'))
      return [{ name: 'Ofertas Piccin', clientId: 'c1', deletedAt: null }];
    return [];
  });
  const manager = { query: jest.fn(async () => over.items ?? Array(16).fill(ITEM)) };
  const dataSource = { query, manager };
  const committer = {
    commitUnit: jest.fn().mockResolvedValue('committed'),
    commitFailure: jest.fn().mockResolvedValue('committed'),
    cancelClaimed: jest.fn().mockResolvedValue('committed'),
    failUnexpected: jest.fn().mockResolvedValue('committed'),
  };
  const port = {
    isAvailable: () => true,
    modelOf: () => 'mock',
    matchImages: jest.fn().mockResolvedValue([]),
    ...over.port,
  };
  const config = { ...readEnrichConfig(fakeConfig({}), { warn: jest.fn() }), ...over.config };
  const processor = new FlyerProEnrichProcessor(
    dataSource as never,
    committer as never,
    port as never,
    config,
  );
  const beats = () =>
    query.mock.calls.filter(([sql]) => String(sql).includes('SET "heartbeatAt" = now()'));
  return { processor, committer, port, query, beats, claimed };
}

describe('FlyerProEnrichProcessor (com banco e comitador simulados)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('batimento', () => {
    it('lote de 40 s: o batimento sai a cada 15 s durante a chamada (duas vezes) e para quando o lote termina', async () => {
      const slow = () => new Promise((resolve) => setTimeout(() => resolve([]), 40_000));
      const { processor, beats } = build({ port: { matchImages: jest.fn(slow) } });

      const handling = processor.handle({ jobId: 'job-1', seq: 3 });
      await jest.advanceTimersByTimeAsync(40_000);
      await handling;

      expect(beats()).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(beats()).toHaveLength(2);
    });

    it('o batimento só vale com a ficha do lote e o job running (condição no próprio UPDATE)', async () => {
      const slow = () => new Promise((resolve) => setTimeout(() => resolve([]), 16_000));
      const { processor, beats } = build({ port: { matchImages: jest.fn(slow) } });

      const handling = processor.handle({ jobId: 'job-1', seq: 3 });
      await jest.advanceTimersByTimeAsync(16_000);
      await handling;

      const [sql, params] = beats()[0];
      expect(sql).toContain(
        `"batchSeq" = $2 AND "status" = 'running' AND "heartbeatAt" IS NOT NULL`,
      );
      expect(params).toEqual(['job-1', 4]);
    });

    it('falha do próprio batimento não derruba o lote', async () => {
      const slow = () => new Promise((resolve) => setTimeout(() => resolve([]), 16_000));
      const { processor, query, committer } = build({ port: { matchImages: jest.fn(slow) } });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      query.mockImplementation(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('SET "heartbeatAt" = now()')) throw new Error('banco caiu');
        if (sql.includes('RETURNING *'))
          return [[jobRow({ status: 'running', batchSeq: 4, phase: 'image_match' })]];
        if (sql.includes('"deletedAt" FROM'))
          return [{ name: 'X', clientId: 'c', deletedAt: null }];
        return [];
      });

      const handling = processor.handle({ jobId: 'job-1', seq: 3 });
      await jest.advanceTimersByTimeAsync(16_000);
      await handling;

      expect(committer.commitUnit).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('prazo da chamada ao provedor', () => {
    it('passou o prazo: a chamada é abandonada, vira falha transitória AI_TIMEOUT e o que chegar depois é descartado', async () => {
      const never = () => new Promise(() => undefined);
      const { processor, committer } = build({
        port: { matchImages: jest.fn(never) },
        config: { batchDeadlineMs: 5000 },
      });

      const handling = processor.handle({ jobId: 'job-1', seq: 3 });
      await jest.advanceTimersByTimeAsync(5000);
      await handling;

      expect(committer.commitUnit).not.toHaveBeenCalled();
      expect(committer.commitFailure).toHaveBeenCalledWith(expect.anything(), 'image_match', {
        code: 'AI_TIMEOUT',
        terminal: false,
      });
    });

    it('antes do prazo: o resultado vai para a gravação', async () => {
      const { processor, committer } = build({ config: { batchDeadlineMs: 5000 } });

      await processor.handle({ jobId: 'job-1', seq: 3 });

      expect(committer.commitUnit).toHaveBeenCalledTimes(1);
      expect(committer.commitFailure).not.toHaveBeenCalled();
    });
  });

  describe('classificação da falha', () => {
    it.each([
      [
        'transitória do provedor',
        new TransientProviderError('HTTP 503'),
        { code: 'AI_PROVIDER_ERROR', terminal: false },
      ],
      [
        'terminal do provedor',
        new TerminalProviderError('chave inválida'),
        { code: 'AI_PROVIDER_ERROR', terminal: true },
      ],
      ['prazo', new ProviderDeadlineError(1000), { code: 'AI_TIMEOUT', terminal: false }],
      ['erro comum', new Error('bug'), null],
      ['valor que não é erro', 'falhou', null],
    ])('%s', (_, error, expected) => {
      expect(classifyBatchError(error)).toEqual(expected);
    });
  });

  describe('nunca lança depois de assumir a ficha', () => {
    it('erro inesperado: o job vira failed INTERNAL e o handler termina sem erro', async () => {
      const boom = jest.fn().mockRejectedValue(new Error('bug no provedor'));
      const { processor, committer } = build({ port: { matchImages: boom } });
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(processor.handle({ jobId: 'job-1', seq: 3 })).resolves.toBeUndefined();

      expect(committer.failUnexpected).toHaveBeenCalledWith(expect.anything(), 'image_match');
      expect(committer.commitFailure).not.toHaveBeenCalled();
    });

    it('a gravação que falha: o erro vira estado (INTERNAL) e o handler não lança', async () => {
      const { processor, committer } = build();
      committer.commitUnit.mockRejectedValue(new Error('deadlock'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(processor.handle({ jobId: 'job-1', seq: 3 })).resolves.toBeUndefined();

      expect(committer.failUnexpected).toHaveBeenCalledTimes(1);
    });

    it('até a gravação do estado de falha que falha: o handler não lança', async () => {
      const { processor, committer } = build({
        port: { matchImages: jest.fn().mockRejectedValue(new Error('bug')) },
      });
      committer.failUnexpected.mockRejectedValue(new Error('banco fora'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(processor.handle({ jobId: 'job-1', seq: 3 })).resolves.toBeUndefined();
    });

    it('sem ficha (entrega dupla ou job terminado): sai sem ler item nem chamar o provedor', async () => {
      const { processor, query, port, committer } = build();
      query.mockResolvedValue([[]]);

      await processor.handle({ jobId: 'job-1', seq: 3 });

      expect(port.matchImages).not.toHaveBeenCalled();
      expect(committer.commitUnit).not.toHaveBeenCalled();
      expect(committer.cancelClaimed).not.toHaveBeenCalled();
    });
  });

  describe('fases pulada e vazia', () => {
    it('fase indisponível: grava o pulo sem chamar o provedor', async () => {
      const { processor, committer, port } = build({ port: { isAvailable: () => false } });

      await processor.handle({ jobId: 'job-1', seq: 3 });

      expect(port.matchImages).not.toHaveBeenCalled();
      const plan = committer.commitUnit.mock.calls[0][1] as UnitPlan;
      expect(plan).toMatchObject({ phase: 'image_match', skipped: true, work: null });
    });

    it('fase sem item: fecha sem chamar o provedor e sem trabalho do provedor no plano', async () => {
      const { processor, committer, port } = build({ items: [] });

      await processor.handle({ jobId: 'job-1', seq: 3 });

      expect(port.matchImages).not.toHaveBeenCalled();
      expect(committer.commitUnit.mock.calls[0][1]).toMatchObject({ work: null, skipped: false });
    });
  });

  describe('linha de log por lote', () => {
    const lines = () =>
      (Logger.prototype.log as jest.Mock).mock.calls.map(([line]) => String(line));
    beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));

    it('lote concluído: jobId, fase, itens, duração total e da chamada em ms, e o resultado', async () => {
      const call = () => new Promise((resolve) => setTimeout(() => resolve([]), 120));
      const { processor, committer } = build({ port: { matchImages: jest.fn(call) } });
      committer.commitUnit.mockImplementation(async () => {
        jest.advanceTimersByTime(30);
        return 'committed';
      });

      const handling = processor.handle({ jobId: 'job-1', seq: 3 });
      await jest.advanceTimersByTimeAsync(120);
      await handling;

      const line = lines().find((text) => text.startsWith('Lote do job')) as string;
      expect(JSON.parse(line.replace('Lote do job ', ''))).toEqual({
        jobId: 'job-1',
        phase: 'image_match',
        items: 16,
        totalMs: 150,
        providerMs: 120,
        outcome: 'gravado',
      });
    });

    it('lote descartado (lote zumbi ou job que terminou no meio da chamada): a linha diz descartado, não gravado', async () => {
      const { processor, committer } = build();
      committer.commitUnit.mockResolvedValue('discarded');

      await processor.handle({ jobId: 'job-1', seq: 3 });

      const line = lines().find((text) => text.startsWith('Lote do job')) as string;
      expect(JSON.parse(line.replace('Lote do job ', ''))).toMatchObject({
        phase: 'image_match',
        outcome: 'descartado',
      });
    });

    it('lote que falhou: a linha traz o resultado de falha e as durações; e nunca chave nem o conteúdo dos itens', async () => {
      const { processor } = build({
        port: {
          matchImages: jest
            .fn()
            .mockRejectedValue(new TransientProviderError('HTTP 503 sk-secreta')),
        },
      });

      await processor.handle({ jobId: 'job-1', seq: 3 });

      const line = lines().find((text) => text.startsWith('Lote do job')) as string;
      expect(line).toContain('"outcome":"falhou AI_PROVIDER_ERROR"');
      expect(line).toContain('"totalMs"');
      expect(line).not.toContain('sk-secreta');
      expect(line).not.toContain('ABACATE');
    });

    it('fase fechada sem item não escreve linha de lote (nenhuma chamada ao provedor)', async () => {
      const { processor } = build({ items: [] });

      await processor.handle({ jobId: 'job-1', seq: 3 });

      expect(lines().filter((text) => text.startsWith('Lote do job'))).toEqual([]);
    });
  });
});
