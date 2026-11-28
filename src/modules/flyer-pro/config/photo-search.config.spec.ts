import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { readPhotoSearchConfig } from './photo-search.config';
import { readSerperApiKey } from './serper-api-key';

const SECRET = 'serper-chave-de-teste-0000';

const read = (env: Record<string, string> = {}) => {
  const warn = jest.fn();
  const config = readPhotoSearchConfig(fakeConfig(env), { warn });
  return { config, warnings: warn.mock.calls.map(([line]) => String(line)) };
};

describe('readPhotoSearchConfig', () => {
  it('sem nenhuma variável: provedor real e 300 buscas por hora, sem aviso', () => {
    expect(read()).toEqual({ config: { provider: 'real', maxPerHour: 300 }, warnings: [] });
  });

  it('mock e o teto lidos do ambiente', () => {
    expect(
      read({ FLYER_PRO_PHOTO_SEARCH_PROVIDER: 'mock', FLYER_PRO_PHOTO_SEARCH_MAX_PER_HOUR: '5' }),
    ).toEqual({ config: { provider: 'mock', maxPerHour: 5 }, warnings: [] });
  });

  it('variáveis vazias valem o padrão, sem aviso', () => {
    expect(
      read({ FLYER_PRO_PHOTO_SEARCH_PROVIDER: '  ', FLYER_PRO_PHOTO_SEARCH_MAX_PER_HOUR: '' }),
    ).toEqual({ config: { provider: 'real', maxPerHour: 300 }, warnings: [] });
  });

  it('provedor desconhecido cai em mock, com aviso que traz o nome e o valor', () => {
    expect(read({ FLYER_PRO_PHOTO_SEARCH_PROVIDER: 'serper' })).toEqual({
      config: { provider: 'mock', maxPerHour: 300 },
      warnings: ['FLYER_PRO_PHOTO_SEARCH_PROVIDER="serper" desconhecido; provedor em mock'],
    });
  });

  it.each(['0', '-3', '2.5', 'muitas'])(
    'teto inválido (%s) vale 300, com aviso que traz o nome e o valor',
    (value) => {
      expect(read({ FLYER_PRO_PHOTO_SEARCH_MAX_PER_HOUR: value })).toEqual({
        config: { provider: 'real', maxPerHour: 300 },
        warnings: [`FLYER_PRO_PHOTO_SEARCH_MAX_PER_HOUR="${value}" inválida; vale o padrão 300`],
      });
    },
  );

  it('Subida sem a chave: a leitura não falha, e a chave nunca entra na configuração nem no aviso', () => {
    const withKey = read({ SERPER_API_KEY: SECRET, FLYER_PRO_PHOTO_SEARCH_MAX_PER_HOUR: 'x' });

    expect(read().config).toEqual({ provider: 'real', maxPerHour: 300 });
    expect(JSON.stringify(withKey)).not.toContain(SECRET);
  });
});

describe('readSerperApiKey', () => {
  it('devolve a chave aparada; ausente ou vazia vale undefined', () => {
    expect(readSerperApiKey(fakeConfig({ SERPER_API_KEY: ` ${SECRET} ` }))).toBe(SECRET);
    expect(readSerperApiKey(fakeConfig({ SERPER_API_KEY: '  ' }))).toBeUndefined();
    expect(readSerperApiKey(fakeConfig({}))).toBeUndefined();
  });
});
