import {
  FLYER_PRO_FORMAT_IDS,
  faceKeysOfLayout,
  findFlyerProFormat,
  sceneFormatIdOf,
} from './flyer-pro-formats';

describe('formatos do Encarte Pro', () => {
  it('folheto-27x40: 27x40, dobra simples, páginas de 1 a 4 e padrão 1', () => {
    expect(findFlyerProFormat('folheto-27x40')).toEqual({
      format: '27x40',
      fold: 'simple',
      pageOptions: [1, 2, 3, 4],
      defaultPageCount: 1,
      layouts: ['single', 'front_back'],
    });
  });

  it('folheto-54x40: 54x40, dobra dupla, páginas 2 ou 4 e padrão 2; só o jornal é aceito', () => {
    expect(findFlyerProFormat('folheto-54x40')).toEqual({
      format: '54x40',
      fold: 'double',
      pageOptions: [2, 4],
      defaultPageCount: 2,
      layouts: ['tabloid'],
    });
  });

  it.each(['folheto-20x27', 'revista-20x26.5', 'folheto-55x36', 'social-1x1', '', 'toString'])(
    'formato fora da tabela (%p) é não suportado',
    (formatId) => {
      expect(findFlyerProFormat(formatId)).toBeNull();
    },
  );

  it('os ids de formato da lista são os dois do Encarte Pro, e o inverso devolve o id da cena', () => {
    expect(FLYER_PRO_FORMAT_IDS).toEqual(['folheto-27x40', 'folheto-54x40']);
    expect(sceneFormatIdOf('27x40')).toBe('folheto-27x40');
    expect(sceneFormatIdOf('54x40')).toBe('folheto-54x40');
  });

  it('as faces de cada layout, em ordem', () => {
    expect(faceKeysOfLayout('single')).toEqual(['single']);
    expect(faceKeysOfLayout('front_back')).toEqual(['front', 'back']);
    expect(faceKeysOfLayout('tabloid')).toEqual(['outer', 'inner']);
  });

  it('layout desconhecido não tem face', () => {
    expect(faceKeysOfLayout('triptico')).toEqual([]);
    expect(faceKeysOfLayout('toString')).toEqual([]);
  });
});
