import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { readEnrichConfig } from '../config/flyer-pro-enrich.config';
import { reconcileAction, ReconcileFacts } from './flyer-pro-enrich-rules';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const secondsAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const config = readEnrichConfig(fakeConfig({}), { warn: jest.fn() });

describe('varredura do reconciliador', () => {
  const facts = (over: Partial<ReconcileFacts>): ReconcileFacts => ({
    heartbeatAt: secondsAgo(10),
    updatedAt: secondsAgo(10),
    cancelRequestedAt: null,
    batchAttempts: 0,
    documentDeleted: false,
    ...over,
  });

  it.each([
    ['lote em dia', facts({}), 'none'],
    ['batimento há 60 s exatos', facts({ heartbeatAt: secondsAgo(60) }), 'none'],
    ['batimento há 61 s', facts({ heartbeatAt: secondsAgo(61) }), 'republish_dead'],
    ['batimento há 5 minutos', facts({ heartbeatAt: secondsAgo(300) }), 'republish_dead'],
    [
      'lote morto com 2 tentativas já contadas',
      facts({ heartbeatAt: secondsAgo(61), batchAttempts: 2 }),
      'fail_stalled',
    ],
    [
      'lote morto com 1 tentativa contada',
      facts({ heartbeatAt: secondsAgo(61), batchAttempts: 1 }),
      'republish_dead',
    ],
    [
      'publicado e não assumido há 301 s',
      facts({ heartbeatAt: null, updatedAt: secondsAgo(301) }),
      'republish_lost',
    ],
    ['publicado há 300 s exatos', facts({ heartbeatAt: null, updatedAt: secondsAgo(300) }), 'none'],
    ['parada pedida sem lote', facts({ heartbeatAt: null, cancelRequestedAt: NOW }), 'cancel'],
    [
      'parada pedida com o lote vivo: o lote fecha o job',
      facts({ cancelRequestedAt: NOW }),
      'none',
    ],
    [
      'parada pedida com o lote morto',
      facts({ heartbeatAt: secondsAgo(61), cancelRequestedAt: NOW }),
      'cancel',
    ],
    [
      'encarte excluído, sem lote em execução',
      facts({ documentDeleted: true, heartbeatAt: null }),
      'cancel',
    ],
    [
      'encarte excluído, com lote em dia: o lote grava e fecha o job',
      facts({ documentDeleted: true, heartbeatAt: secondsAgo(5) }),
      'none',
    ],
    [
      'encarte excluído, com o lote morto',
      facts({ documentDeleted: true, heartbeatAt: secondsAgo(61) }),
      'cancel',
    ],
  ])('%s: %s', (_, input, expected) => {
    expect(reconcileAction(input, NOW, config)).toBe(expected);
  });

  it('respeita STALE_SECONDS e MAX_ATTEMPTS da configuração', () => {
    const custom = readEnrichConfig(
      fakeConfig({ FLYER_PRO_ENRICH_STALE_SECONDS: '10', FLYER_PRO_ENRICH_MAX_ATTEMPTS: '1' }),
      { warn: jest.fn() },
    );

    expect(reconcileAction(facts({ heartbeatAt: secondsAgo(11) }), NOW, custom)).toBe(
      'fail_stalled',
    );
  });
});
