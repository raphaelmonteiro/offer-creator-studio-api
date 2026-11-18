import { readFileSync } from 'fs';
import { join } from 'path';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { isEnrichEnabled, readEnrichConfig } from './flyer-pro-enrich.config';

const read = (env: Record<string, string> = {}) => {
  const warn = jest.fn();
  const config = readEnrichConfig(fakeConfig(env), { warn });
  return { config, warnings: warn.mock.calls.map(([line]) => String(line)) };
};

const DEFAULTS = {
  enabled: true,
  provider: 'real',
  concurrency: 2,
  imageBatch: 16,
  categoryBatch: 40,
  spellBatch: 40,
  batchExpireSeconds: 300,
  batchDeadlineMs: 240_000,
  staleSeconds: 60,
  maxAttempts: 3,
};

describe('readEnrichConfig', () => {
  it('sem nenhuma variável: os padrões do requisito, sem aviso', () => {
    expect(read()).toEqual({ config: DEFAULTS, warnings: [] });
  });

  it('variáveis vazias valem o padrão, sem aviso', () => {
    const { config, warnings } = read({
      FLYER_PRO_ENRICH_PROVIDER: '  ',
      FLYER_PRO_ENRICH_IMAGE_BATCH: '',
    });
    expect(config).toEqual(DEFAULTS);
    expect(warnings).toEqual([]);
  });

  it('lê os valores válidos das dez variáveis', () => {
    expect(
      read({
        FLYER_PRO_ENRICH_ENABLED: 'true',
        FLYER_PRO_ENRICH_PROVIDER: 'mock',
        FLYER_PRO_ENRICH_CONCURRENCY: '1',
        FLYER_PRO_ENRICH_IMAGE_BATCH: '24',
        FLYER_PRO_ENRICH_CATEGORY_BATCH: '10',
        FLYER_PRO_ENRICH_SPELL_BATCH: '20',
        FLYER_PRO_ENRICH_BATCH_EXPIRE_SECONDS: '120',
        FLYER_PRO_ENRICH_BATCH_DEADLINE_MS: '5000',
        FLYER_PRO_ENRICH_STALE_SECONDS: '30',
        FLYER_PRO_ENRICH_MAX_ATTEMPTS: '5',
      }),
    ).toEqual({
      config: {
        enabled: true,
        provider: 'mock',
        concurrency: 1,
        imageBatch: 24,
        categoryBatch: 10,
        spellBatch: 20,
        batchExpireSeconds: 120,
        batchDeadlineMs: 5000,
        staleSeconds: 30,
        maxAttempts: 5,
      },
      warnings: [],
    });
  });

  describe('provedor', () => {
    it('valor desconhecido vale mock, com aviso que traz o valor recebido', () => {
      const { config, warnings } = read({ FLYER_PRO_ENRICH_PROVIDER: 'openai' });

      expect(config.provider).toBe('mock');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('openai');
    });

    it('real e mock valem como estão, sem aviso', () => {
      expect(read({ FLYER_PRO_ENRICH_PROVIDER: 'real' })).toMatchObject({
        config: { provider: 'real' },
        warnings: [],
      });
      expect(read({ FLYER_PRO_ENRICH_PROVIDER: 'mock' })).toMatchObject({
        config: { provider: 'mock' },
        warnings: [],
      });
    });
  });

  describe('flag do job', () => {
    it('só o texto `false` desliga; qualquer outro valor, ou a variável ausente, deixa ligado', () => {
      expect(read({ FLYER_PRO_ENRICH_ENABLED: 'false' }).config.enabled).toBe(false);
      for (const value of ['true', '0', 'no', 'desligado', '']) {
        expect(read({ FLYER_PRO_ENRICH_ENABLED: value }).config.enabled).toBe(true);
      }
      expect(read().config.enabled).toBe(true);
    });

    it('isEnrichEnabled lê só a flag, com a mesma regra', () => {
      expect(isEnrichEnabled(fakeConfig({ FLYER_PRO_ENRICH_ENABLED: 'false' }))).toBe(false);
      expect(isEnrichEnabled(fakeConfig({ FLYER_PRO_ENRICH_ENABLED: '0' }))).toBe(true);
      expect(isEnrichEnabled(fakeConfig({}))).toBe(true);
    });
  });

  it('o backend/.env.example traz as dez variáveis com os padrões que o código usa', () => {
    const example = readFileSync(join(__dirname, '../../../../.env.example'), 'utf8');
    const defaults: Record<string, string> = {
      ENABLED: 'true',
      PROVIDER: 'real',
      CONCURRENCY: '2',
      IMAGE_BATCH: '16',
      CATEGORY_BATCH: '40',
      SPELL_BATCH: '40',
      BATCH_EXPIRE_SECONDS: '300',
      BATCH_DEADLINE_MS: '240000',
      STALE_SECONDS: '60',
      MAX_ATTEMPTS: '3',
    };
    for (const [name, value] of Object.entries(defaults)) {
      expect(example).toMatch(new RegExp(`^FLYER_PRO_ENRICH_${name}=${value}(\\s|$)`, 'm'));
    }
    expect(Object.keys(defaults)).toHaveLength(10);
  });
});
