import { sentTo } from '../../ai/utils/openai-chat.testutil';
import { McProject } from '../entities/mc-project.entity';
import { SCRIPT_STEP_ID } from './mc-script.processor.testutil';
import {
  DirectorFormat,
  directorRig,
  FORMATS,
  okReply,
  stepFailure,
  TERRA,
  useOpenAiDirectorEnv,
} from './mc-script.processor.director.testutil';

/**
 * Chamada do diretor nos quatro formatos (change 42, task 1.10): uma função só pelo cliente do SDK, com a família
 * do modelo, prazo, repetição só de taxa e 5xx e a mesma mensagem de falha. Cliente simulado, nenhuma chamada paga.
 * Repetição e falha: `mc-script.processor.director-failures.spec.ts`.
 */
/** Nome do `json_schema` de cada formato (o mesmo de antes da change). */
const SCHEMA_NAMES: Record<DirectorFormat, string> = {
  v1: 'roteiro_comercial',
  v2: 'roteiro_comercial_v2',
  talking_art: 'fala_arte_que_fala',
  offer_carousel: 'falas_ofertas_em_sequencia',
  offer_piece: 'falas_ofertas_em_sequencia',
};

describe('McScriptProcessor — chamada do diretor (42, 1.10)', () => {
  const config: Record<string, string> = {};
  useOpenAiDirectorEnv(config);

  describe.each(FORMATS)('formato %s', (format) => {
    it('Diretor em Terra: esforço low, teto da família nova, o mesmo json_schema e sem temperature', async () => {
      const { processor, create } = directorRig(format, config, okReply(format));
      await processor.process({ stepId: SCRIPT_STEP_ID });
      expect(create).toHaveBeenCalledTimes(1);
      const { body, options } = sentTo(create);
      expect(body).toMatchObject({
        model: TERRA,
        reasoning_effort: 'low',
        max_completion_tokens: 16_000,
        response_format: {
          type: 'json_schema',
          json_schema: { name: SCHEMA_NAMES[format], strict: true },
        },
      });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('max_tokens');
      expect(options).toEqual({ maxRetries: 0, timeout: 100_000 });
    });

    it('volta a gpt-4o: o corpo de hoje (temperature 0.7, sem teto, sem esforço)', async () => {
      config.MC_DIRECTOR_MODEL = 'gpt-4o';
      const { processor, create } = directorRig(format, config, okReply(format));
      await processor.process({ stepId: SCRIPT_STEP_ID });

      const { body, options } = sentTo(create);
      expect(body).toMatchObject({ model: 'gpt-4o', temperature: 0.7 });
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(options).toEqual({ maxRetries: 0, timeout: 100_000 });
    });

    it('grava o roteiro do formato com a resposta do provedor', async () => {
      const { harness, processor } = directorRig(format, config, okReply(format));
      await processor.process({ stepId: SCRIPT_STEP_ID });

      expect(harness.manager.update).toHaveBeenCalledWith(
        McProject,
        { id: 'p1' },
        expect.objectContaining({ script: expect.any(Object) }),
      );
      expect(harness.saved()).toMatchObject(SAVED[format]);
    });
  });

  it('o diretor não herda OPENAI_TEXT_MODEL, e variável vazia ou só com espaços vale o padrão', async () => {
    config.OPENAI_TEXT_MODEL = 'gpt-4o';
    config.MC_DIRECTOR_MODEL = '   ';
    const first = directorRig('v2', config, okReply('v2'));
    await first.processor.process({ stepId: SCRIPT_STEP_ID });
    expect(sentTo(first.create).body.model).toBe(TERRA);

    config.MC_DIRECTOR_MODEL = '';
    const second = directorRig('v1', config, okReply('v1'));
    await second.processor.process({ stepId: SCRIPT_STEP_ID });
    expect(sentTo(second.create).body.model).toBe(TERRA);
  });

  it('sem OPENAI_API_KEY falha como sempre, sem chamada', async () => {
    delete config.OPENAI_API_KEY;
    const { harness, processor, create } = directorRig('v2', config);
    await processor.process({ stepId: SCRIPT_STEP_ID });

    expect(create).not.toHaveBeenCalled();
    expect(stepFailure(harness)).toBe('script_failed: OPENAI_API_KEY ausente');
  });
});

/** O que o roteiro de cada formato traz para a resposta de `REPLIES` (montagem do domínio, igual à de antes). */
const SAVED: Record<DirectorFormat, Record<string, unknown>> = {
  v1: {
    version: 2,
    scenes: [
      {
        idx: 0,
        actionPrompt: 'Mascote acena',
        dialogue: 'Café Pilão a doze e noventa!',
        durationS: 6,
      },
    ],
    seal: { products: [{ name: 'Café Pilão', price: '12,90' }] },
    endcard: { storeName: 'Mercadão' },
  },
  v2: {
    version: 1,
    scenes: [
      { idx: 0, sceneType: 'presenter', dialogue: 'Café Pilão a doze e noventa!', durationS: 6 },
    ],
    endcard: { storeName: 'Mercadão' },
  },
  talking_art: {
    format: 'talking_art',
    narration:
      'Chegou a hora das ofertas! Arroz por vinte e quatro reais e noventa centavos. Corre pra loja!',
    citedOfferIds: ['of-arroz'],
    endcard: { storeName: 'Mercadão' },
  },
  offer_carousel: {
    format: 'offer_carousel',
    endcard: { storeName: 'Mercadão' },
  },
  offer_piece: {
    format: 'offer_piece',
    endcard: { storeName: 'Mercadão' },
  },
};
