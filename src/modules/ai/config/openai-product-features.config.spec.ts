import {
  getProductAiConfig,
  readPositiveIntegerConfig,
  ProductAiFeature,
} from './openai-product-features.config';
import { fakeConfig } from '../utils/openai-chat.testutil';

const FEATURES: ProductAiFeature[] = [
  'spellcheck',
  'categorization',
  'nameParser',
  'galleryVision',
  'translation',
];

describe('getProductAiConfig', () => {
  it('sem variáveis: gpt-6-luna nas quatro de texto e gpt-6.1-terra na leitura da foto', () => {
    const config = getProductAiConfig(fakeConfig());
    expect(config.spellcheck.model).toBe('gpt-6-luna');
    expect(config.categorization.model).toBe('gpt-6-luna');
    expect(config.nameParser.model).toBe('gpt-6-luna');
    expect(config.translation.model).toBe('gpt-6-luna');
    expect(config.galleryVision.model).toBe('gpt-6.1-terra');
  });

  it('prazos padrão: tradução 10 s, ortografia 30 s, as outras três 60 s', () => {
    const config = getProductAiConfig(fakeConfig());
    expect(config.translation.timeoutMs).toBe(10_000);
    expect(config.spellcheck.timeoutMs).toBe(30_000);
    expect(config.categorization.timeoutMs).toBe(60_000);
    expect(config.nameParser.timeoutMs).toBe(60_000);
    expect(config.galleryVision.timeoutMs).toBe(60_000);
  });

  it('variável vazia ou só com espaços vale como ausente', () => {
    const config = getProductAiConfig(
      fakeConfig({ OPENAI_TRANSLATION_MODEL: '', OPENAI_SPELLCHECK_MODEL: '   ' }),
    );
    expect(config.translation.model).toBe('gpt-6-luna');
    expect(config.spellcheck.model).toBe('gpt-6-luna');
  });

  it('uma variável muda só a sua feature', () => {
    const config = getProductAiConfig(fakeConfig({ OPENAI_SPELLCHECK_MODEL: 'gpt-4o' }));
    expect(config.spellcheck.model).toBe('gpt-4o');
    for (const other of FEATURES.filter((f) => f !== 'spellcheck')) {
      expect(config[other].model).toBe(other === 'galleryVision' ? 'gpt-6.1-terra' : 'gpt-6-luna');
    }
  });

  it('aceita o modelo com espaços nas pontas, sem os espaços', () => {
    const config = getProductAiConfig(fakeConfig({ OPENAI_GALLERY_VISION_MODEL: ' gpt-4o-mini ' }));
    expect(config.galleryVision.model).toBe('gpt-4o-mini');
  });

  it('OPENAI_TEXT_MODEL e OPENAI_FAST_TEXT_MODEL não mudam nenhuma das cinco', () => {
    const config = getProductAiConfig(
      fakeConfig({ OPENAI_TEXT_MODEL: 'gpt-4o', OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini' }),
    );
    expect(FEATURES.map((f) => config[f].model)).toEqual([
      'gpt-6-luna',
      'gpt-6-luna',
      'gpt-6-luna',
      'gpt-6.1-terra',
      'gpt-6-luna',
    ]);
  });

  it('uma variável de prazo muda só o prazo da sua feature', () => {
    const config = getProductAiConfig(fakeConfig({ OPENAI_TRANSLATION_TIMEOUT_MS: '5000' }));
    expect(config.translation.timeoutMs).toBe(5000);
    expect(config.spellcheck.timeoutMs).toBe(30_000);
    expect(config.categorization.timeoutMs).toBe(60_000);
    expect(config.nameParser.timeoutMs).toBe(60_000);
    expect(config.galleryVision.timeoutMs).toBe(60_000);
  });

  it.each(['', '   ', '0', '-5', 'abc', '5s', '1.5', 'NaN', 'Infinity'])(
    'prazo inválido (%p) vale o padrão da feature',
    (invalid) => {
      const config = getProductAiConfig(fakeConfig({ OPENAI_SPELLCHECK_TIMEOUT_MS: invalid }));
      expect(config.spellcheck.timeoutMs).toBe(30_000);
    },
  );

  it('OPENAI_TIMEOUT_MS (180000, do provedor de imagem) não muda nenhum dos cinco prazos', () => {
    const config = getProductAiConfig(fakeConfig({ OPENAI_TIMEOUT_MS: '180000' }));
    expect(FEATURES.map((f) => config[f].timeoutMs)).toEqual([
      30_000, 60_000, 60_000, 60_000, 10_000,
    ]);
  });
});

describe('readPositiveIntegerConfig', () => {
  it('valor válido, ausente e inválido', () => {
    expect(readPositiveIntegerConfig(fakeConfig({ X: '8' }), 'X', 4)).toBe(8);
    expect(readPositiveIntegerConfig(fakeConfig(), 'X', 4)).toBe(4);
    expect(readPositiveIntegerConfig(fakeConfig({ X: '0' }), 'X', 4)).toBe(4);
    expect(readPositiveIntegerConfig(fakeConfig({ X: 'oito' }), 'X', 4)).toBe(4);
  });
});
