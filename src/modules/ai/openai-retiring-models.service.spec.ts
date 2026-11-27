import { Logger } from '@nestjs/common';
import { fakeConfig } from './utils/openai-chat.testutil';
import { PRODUCT_AI_MODEL_VARS } from './config/openai-product-features.config';
import { OpenAiRetiringModelsWarning } from './openai-retiring-models.service';

function warningsFor(env: Record<string, string>): string[] {
  return new OpenAiRetiringModelsWarning(fakeConfig(env)).warnings();
}

describe('OpenAiRetiringModelsWarning (requisito "Aviso ao subir com modelo que sai do ar")', () => {
  afterEach(() => jest.restoreAllMocks());

  it('VM com o modelo de hoje pinado: um aviso por variável, com nome, valor e a data', () => {
    const lines = warningsFor({
      OPENAI_TEXT_MODEL: 'gpt-4o',
      OPENAI_SPELLCHECK_MODEL: 'gpt-4o',
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('OPENAI_TEXT_MODEL=gpt-4o');
    expect(lines[0]).toContain('2027-01-14');
    expect(lines[1]).toContain('OPENAI_SPELLCHECK_MODEL=gpt-4o');
  });

  it('o aviso sai no log ao subir (API e worker) e o processo sobe normalmente', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new OpenAiRetiringModelsWarning(fakeConfig({ OPENAI_TEXT_MODEL: 'gpt-4o' }));
    expect(() => service.onModuleInit()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('OPENAI_TEXT_MODEL=gpt-4o');
  });

  it('Padrões novos: nenhum aviso de modelo que sai do ar', () => {
    expect(warningsFor({})).toEqual([]);
    expect(warningsFor({ OPENAI_TEXT_MODEL: 'gpt-6-luna', MC_DIRECTOR_MODEL: '  ' })).toEqual([]);
  });

  it.each([
    'OPENAI_TEXT_MODEL',
    'OPENAI_FAST_TEXT_MODEL',
    'MC_DIRECTOR_MODEL',
    'MC_KIT_VISION_MODEL',
    'EAN_JUDGE_MODEL_A',
    ...PRODUCT_AI_MODEL_VARS,
  ])('avisa a variável %s em gpt-4o-mini', (name) => {
    const lines = warningsFor({ [name]: 'gpt-4o-mini' });
    expect(lines.some((line) => line.startsWith(name + '=gpt-4o-mini'))).toBe(true);
  });

  it('as cinco features da change 01 estão na lista', () => {
    expect(PRODUCT_AI_MODEL_VARS).toEqual([
      'OPENAI_SPELLCHECK_MODEL',
      'OPENAI_CATEGORIZATION_MODEL',
      'OPENAI_NAME_PARSER_MODEL',
      'OPENAI_GALLERY_VISION_MODEL',
      'OPENAI_TRANSLATION_MODEL',
    ]);
  });

  it('o juiz B herda o valor do A e também é avisado', () => {
    const lines = warningsFor({ EAN_JUDGE_MODEL_A: 'gpt-4o' });
    expect(lines.map((line) => line.split('=')[0])).toEqual([
      'EAN_JUDGE_MODEL_A',
      'EAN_JUDGE_MODEL_B',
    ]);
  });

  it('variável de modelo ausente, vazia ou só com espaços não gera aviso', () => {
    expect(warningsFor({ OPENAI_FAST_TEXT_MODEL: '', OPENAI_TEXT_MODEL: '   ' })).toEqual([]);
  });

  it('Variável do DALL-E definida: avisa que não tem efeito', () => {
    const lines = warningsFor({ OPENAI_ENABLE_DALLE_FALLBACK: 'true' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('OPENAI_ENABLE_DALLE_FALLBACK não tem efeito');
  });

  it('avisa as duas variáveis do DALL-E e ignora a vazia', () => {
    const both = warningsFor({
      OPENAI_ENABLE_DALLE_FALLBACK: 'false',
      OPENAI_DALLE_FALLBACK_MODEL: 'dall-e-3',
    });
    expect(both).toHaveLength(2);
    expect(warningsFor({ OPENAI_DALLE_FALLBACK_MODEL: '' })).toEqual([]);
  });
});
