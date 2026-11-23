import {
  COMMERCIALS_GC_URL_PREFIX,
  GC_URL_PREFIX,
  selectGarbage,
} from '../../shared/gc/uploads-gc.rules';
import { SCENE_UPLOADS_URL_PREFIX } from '../../shared/gc/template-scenes-gc.runner';

const FONTS_PATH = '/uploads/fonts/9b2f.ttf';

/**
 * As fontes enviadas ficam fora de toda limpeza automática de uploads (change 34-add-flyer-pro-google-fonts, A-16): o
 * encarte guarda o endereço do arquivo, então a limpeza que passar a cobrir `/uploads/fonts/` derruba esses encartes
 * para a fonte de reserva. Este spec falha se um prefixo de limpeza passar a cobri-lo.
 */
describe('Limpezas de uploads e /uploads/fonts/', () => {
  const prefixes = {
    animations: GC_URL_PREFIX,
    commercials: COMMERCIALS_GC_URL_PREFIX,
    'template-scenes': SCENE_UPLOADS_URL_PREFIX,
  };

  it.each(Object.entries(prefixes))(
    'o prefixo de %s não cobre /uploads/fonts/',
    (_name, prefix) => {
      expect(FONTS_PATH.startsWith(prefix)).toBe(false);
      expect('/uploads/fonts/'.startsWith(prefix)).toBe(false);
    },
  );

  it('o GC de animations não seleciona o arquivo de uma fonte, nem de um asset vencido', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const old = new Date('2026-01-01T00:00:00Z');
    const selection = selectGarbage(
      [
        {
          id: 'a1',
          kind: 'mascot_video',
          createdAt: old,
          deletedAt: old,
          fileUrl: FONTS_PATH,
          alphaUrl: null,
          posterUrl: null,
          thumbUrl: null,
        },
      ],
      now,
    );
    expect(selection).toEqual([]);
  });
});
