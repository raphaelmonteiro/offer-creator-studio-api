import { readFileSync } from 'fs';
import { join } from 'path';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { readEnrichConfig } from './flyer-pro-enrich.config';

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
  });

  describe('tamanhos e prazos inválidos caem no padrão', () => {
    it('zero, texto e lote de fotos que não é múltiplo de 8: o padrão e um aviso por variável, com nome e valor', () => {
      const { config, warnings } = read({
        FLYER_PRO_ENRICH_CATEGORY_BATCH: '0',
        FLYER_PRO_ENRICH_SPELL_BATCH: 'abc',
        FLYER_PRO_ENRICH_IMAGE_BATCH: '12',
      });

      expect([config.categoryBatch, config.spellBatch, config.imageBatch]).toEqual([40, 40, 16]);
      expect(warnings).toHaveLength(3);
      for (const sent of [
        'FLYER_PRO_ENRICH_CATEGORY_BATCH="0"',
        'FLYER_PRO_ENRICH_SPELL_BATCH="abc"',
        'FLYER_PRO_ENRICH_IMAGE_BATCH="12"',
      ]) {
        expect(warnings.filter((line) => line.includes(sent))).toHaveLength(1);
      }
    });

    const NUMERIC = [
      ['CONCURRENCY', 'concurrency', 2],
      ['IMAGE_BATCH', 'imageBatch', 16],
      ['CATEGORY_BATCH', 'categoryBatch', 40],
      ['SPELL_BATCH', 'spellBatch', 40],
      ['BATCH_EXPIRE_SECONDS', 'batchExpireSeconds', 300],
      ['BATCH_DEADLINE_MS', 'batchDeadlineMs', 240_000],
      ['STALE_SECONDS', 'staleSeconds', 60],
      ['MAX_ATTEMPTS', 'maxAttempts', 3],
    ] as const;

    it.each(
      NUMERIC.flatMap((row) => ['0', '-5', '2.5', 'dez', '1e3x'].map((bad) => [...row, bad])),
    )('%s inválido (%s): vale o padrão com um aviso', (name, key, fallback, bad) => {
      const { config, warnings } = read({ [`FLYER_PRO_ENRICH_${name}`]: String(bad) });

      expect(config[key]).toBe(fallback);
      expect(warnings).toEqual([expect.stringContaining(`FLYER_PRO_ENRICH_${name}="${bad}"`)]);
    });

    it('sem teto superior: valor enorme e válido vale como veio, sem aviso', () => {
      const { config, warnings } = read({
        FLYER_PRO_ENRICH_CATEGORY_BATCH: '100000',
        FLYER_PRO_ENRICH_BATCH_DEADLINE_MS: '99999999',
      });

      expect([config.categoryBatch, config.batchDeadlineMs]).toEqual([100_000, 99_999_999]);
      expect(warnings).toEqual([]);
    });

    it('lote de fotos de 8: 78 itens pedem 10 lotes; de 24, sem aviso, pedem 4', () => {
      const eight = read({ FLYER_PRO_ENRICH_IMAGE_BATCH: '8' });
      const twentyFour = read({ FLYER_PRO_ENRICH_IMAGE_BATCH: '24' });

      expect(Math.ceil(78 / eight.config.imageBatch)).toBe(10);
      expect(Math.ceil(78 / twentyFour.config.imageBatch)).toBe(4);
      expect(twentyFour.warnings).toEqual([]);
    });

    it('os padrões, 78 itens: 2 lotes de categorias, 2 de ortografia e 5 de fotos', () => {
      const { config } = read();

      expect(
        [config.categoryBatch, config.spellBatch, config.imageBatch].map((size) =>
          Math.ceil(78 / size),
        ),
      ).toEqual([2, 2, 5]);
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
