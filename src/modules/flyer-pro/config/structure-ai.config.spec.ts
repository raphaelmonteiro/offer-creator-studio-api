import { readFileSync } from 'fs';
import { join } from 'path';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { readStructureAiConfig } from './structure-ai.config';

const read = (env: Record<string, string> = {}) => {
  const warn = jest.fn();
  const config = readStructureAiConfig(fakeConfig(env), { warn });
  return { config, warnings: warn.mock.calls.map(([line]) => String(line)) };
};

describe('readStructureAiConfig', () => {
  it('sem nenhuma variável: os padrões do contrato, sem aviso', () => {
    expect(read()).toEqual({
      config: {
        enabled: true,
        provider: 'real',
        model: 'gpt-6-luna',
        effort: 'medium',
        timeoutMs: 60_000,
        maxPerHour: 20,
        maxHeroes: 12,
        examples: 3,
      },
      warnings: [],
    });
  });

  it('Sem as variáveis de esforço e prazo: valem o esforço medium e os 60.000 ms, sem aviso', () => {
    expect(read({ FLYER_PRO_STRUCTURE_AI_PROVIDER: 'mock' })).toMatchObject({
      config: { effort: 'medium', timeoutMs: 60_000 },
      warnings: [],
    });
  });

  it('Esforço low ainda aceito: low e 25.000 ms fixados (como o .env deste Linux tinha antes da change 45) valem, sem aviso', () => {
    expect(
      read({
        FLYER_PRO_STRUCTURE_AI_EFFORT: 'low',
        FLYER_PRO_STRUCTURE_AI_TIMEOUT_MS: '25000',
      }),
    ).toMatchObject({ config: { effort: 'low', timeoutMs: 25_000 }, warnings: [] });
  });

  it('variáveis vazias valem o padrão, sem aviso', () => {
    const { config, warnings } = read({
      FLYER_PRO_STRUCTURE_AI_MODEL: '  ',
      FLYER_PRO_STRUCTURE_AI_TIMEOUT_MS: '',
      FLYER_PRO_STRUCTURE_AI_PROVIDER: '',
    });
    expect(config).toMatchObject({ model: 'gpt-6-luna', timeoutMs: 60_000, provider: 'real' });
    expect(warnings).toEqual([]);
  });

  it('só o texto `false` desliga a rota; qualquer outro valor a deixa ligada', () => {
    expect(read({ FLYER_PRO_STRUCTURE_AI_ENABLED: 'false' }).config.enabled).toBe(false);
    for (const value of ['true', '0', 'no', 'desligada', '']) {
      expect(read({ FLYER_PRO_STRUCTURE_AI_ENABLED: value }).config.enabled).toBe(true);
    }
  });

  it('lê os valores válidos das oito variáveis', () => {
    expect(
      read({
        FLYER_PRO_STRUCTURE_AI_PROVIDER: 'mock',
        FLYER_PRO_STRUCTURE_AI_MODEL: 'gpt-6.1-terra',
        FLYER_PRO_STRUCTURE_AI_EFFORT: 'medium',
        FLYER_PRO_STRUCTURE_AI_TIMEOUT_MS: '1000',
        FLYER_PRO_STRUCTURE_AI_MAX_PER_HOUR: '5',
        FLYER_PRO_STRUCTURE_AI_MAX_HEROES: '2',
        FLYER_PRO_STRUCTURE_AI_EXAMPLES: '10',
      }),
    ).toEqual({
      config: {
        enabled: true,
        provider: 'mock',
        model: 'gpt-6.1-terra',
        effort: 'medium',
        timeoutMs: 1000,
        maxPerHour: 5,
        maxHeroes: 2,
        examples: 10,
      },
      warnings: [],
    });
  });

  it('Números e esforço inválidos: o padrão (esforço medium), com um aviso para cada um', () => {
    const { config, warnings } = read({
      FLYER_PRO_STRUCTURE_AI_MAX_PER_HOUR: 'abc',
      FLYER_PRO_STRUCTURE_AI_EXAMPLES: '11',
      FLYER_PRO_STRUCTURE_AI_EFFORT: 'alto',
    });
    expect(config).toMatchObject({ maxPerHour: 20, examples: 3, effort: 'medium' });
    expect(warnings).toHaveLength(3);
    const text = warnings.join('\n');
    expect(text).toContain('FLYER_PRO_STRUCTURE_AI_MAX_PER_HOUR="abc"');
    expect(text).toContain('FLYER_PRO_STRUCTURE_AI_EXAMPLES="11"');
    expect(text).toContain('FLYER_PRO_STRUCTURE_AI_EFFORT="alto" inválido; vale "medium"');
  });

  it.each(['0', '-3', '2.5', 'NaN'])('prazo, teto por hora e destaques recusam "%s"', (value) => {
    const { config, warnings } = read({
      FLYER_PRO_STRUCTURE_AI_TIMEOUT_MS: value,
      FLYER_PRO_STRUCTURE_AI_MAX_PER_HOUR: value,
      FLYER_PRO_STRUCTURE_AI_MAX_HEROES: value,
    });
    expect(config).toMatchObject({ timeoutMs: 60_000, maxPerHour: 20, maxHeroes: 12 });
    expect(warnings).toHaveLength(3);
  });

  it('EXAMPLES aceita 0 (desliga a leitura) e recusa o que passa de 10 ou é negativo', () => {
    expect(read({ FLYER_PRO_STRUCTURE_AI_EXAMPLES: '0' })).toMatchObject({
      config: { examples: 0 },
      warnings: [],
    });
    for (const value of ['-1', '11', '1.5']) {
      const { config, warnings } = read({ FLYER_PRO_STRUCTURE_AI_EXAMPLES: value });
      expect(config.examples).toBe(3);
      expect(warnings).toHaveLength(1);
    }
  });

  it('esforço aceita none, low e medium', () => {
    for (const effort of ['none', 'low', 'medium']) {
      expect(read({ FLYER_PRO_STRUCTURE_AI_EFFORT: effort }).config.effort).toBe(effort);
    }
  });

  it('provedor desconhecido cai em mock, com aviso que traz o valor recebido', () => {
    const { config, warnings } = read({ FLYER_PRO_STRUCTURE_AI_PROVIDER: 'openai' });
    expect(config.provider).toBe('mock');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"openai"');
  });

  it('o backend/.env.example traz as oito variáveis com os padrões que o código usa', () => {
    const example = readFileSync(join(__dirname, '../../../../.env.example'), 'utf8');
    const { config } = read();
    const defaults: Record<string, string> = {
      ENABLED: String(config.enabled),
      PROVIDER: config.provider,
      MODEL: config.model,
      EFFORT: config.effort,
      TIMEOUT_MS: String(config.timeoutMs),
      MAX_PER_HOUR: String(config.maxPerHour),
      MAX_HEROES: String(config.maxHeroes),
      EXAMPLES: String(config.examples),
    };
    for (const [name, value] of Object.entries(defaults)) {
      // O modelo tem padrão no código e fica em linha comentada com o valor (D-11 da change 42); as outras ficam ativas.
      const comment = name === 'MODEL' ? '(# )?' : '';
      expect(example).toMatch(
        new RegExp(`^${comment}FLYER_PRO_STRUCTURE_AI_${name}=${value}(\\s|$)`, 'm'),
      );
    }
  });
});
