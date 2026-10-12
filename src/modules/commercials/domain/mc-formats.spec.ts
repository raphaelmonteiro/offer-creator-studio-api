import { HttpException } from '@nestjs/common';
import { assertFormatEnabled, isFormatEnabled, parseMcFormats } from './mc-pipeline.config';

/** Admissão por formato (video-formatos-personagem, design D13 / spec video-composition-render). */
describe('MC_FORMATS (admissão por formato)', () => {
  it('vazio ou ausente = nenhum formato novo habilitado', () => {
    expect(parseMcFormats({})).toEqual([]);
    expect(parseMcFormats({ MC_FORMATS: '' })).toEqual([]);
    expect(parseMcFormats({ MC_FORMATS: ' , ' })).toEqual([]);
  });

  it('lista separada por vírgula, com espaços e maiúsculas tolerados, sem duplicatas', () => {
    expect(parseMcFormats({ MC_FORMATS: 'talking_art,offer_carousel' })).toEqual([
      'talking_art',
      'offer_carousel',
    ]);
    expect(parseMcFormats({ MC_FORMATS: ' Talking_Art , talking_art ' })).toEqual(['talking_art']);
  });

  it('token desconhecido é erro de configuração (falha no boot)', () => {
    expect(() => parseMcFormats({ MC_FORMATS: 'talking_art,carrossel' })).toThrow(
      /MC_FORMATS: formato desconhecido "carrossel"/,
    );
  });

  it('scenes sempre passa, mesmo com MC_FORMATS vazio', () => {
    expect(isFormatEnabled('scenes', {})).toBe(true);
    expect(() => assertFormatEnabled('scenes', {})).not.toThrow();
  });

  it('formato novo fora da lista → 422 FORMAT_NOT_ENABLED', () => {
    expect(isFormatEnabled('talking_art', {})).toBe(false);
    try {
      assertFormatEnabled('talking_art', { MC_FORMATS: 'offer_carousel' });
      fail('deveria lançar');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const http = err as HttpException;
      expect(http.getStatus()).toBe(422);
      expect(http.getResponse()).toMatchObject({
        code: 'FORMAT_NOT_ENABLED',
        details: { format: 'talking_art' },
      });
    }
  });

  it('formato novo na lista → passa', () => {
    expect(isFormatEnabled('offer_carousel', { MC_FORMATS: 'talking_art,offer_carousel' })).toBe(
      true,
    );
    expect(() =>
      assertFormatEnabled('offer_carousel', { MC_FORMATS: 'talking_art,offer_carousel' }),
    ).not.toThrow();
  });
});
