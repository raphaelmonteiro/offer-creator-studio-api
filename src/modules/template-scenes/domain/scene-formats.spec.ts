import { computeSceneZones, findSceneFormat, SCENE_FORMATS } from './scene-formats';

describe('scene-formats', () => {
  it('lista os dez formatos de impressão', () => {
    expect(Object.keys(SCENE_FORMATS)).toHaveLength(10);
  });

  it.each(['spread-55x55', 'spread-55x30', 'revista-57x40', 'instagram-feed', 'nao-existe'])(
    'recusa %s (spread, social ou inexistente)',
    (id) => {
      expect(findSceneFormat(id)).toBeNull();
    },
  );

  it('não confunde propriedades do Object com formatos', () => {
    expect(findSceneFormat('constructor')).toBeNull();
    expect(findSceneFormat('__proto__')).toBeNull();
  });

  it('calcula as zonas do folheto 27x54 como o protótipo', () => {
    const zones = computeSceneZones(findSceneFormat('folheto-27x54')!);
    expect(zones.header).toEqual({ x: 0, y: 0, w: 1, h: 6 / 54 });
    expect(zones.footer.y).toBeCloseTo(1 - 4 / 54, 10);
    expect(zones.body.y).toBeCloseTo(6 / 54, 10);
    expect(zones.body.h).toBeCloseTo(1 - 6 / 54 - 4 / 54, 10);
  });

  it('limita cabeçalho e rodapé a 30% da altura', () => {
    const zones = computeSceneZones({
      id: 'x',
      artWidthCm: 10,
      artHeightCm: 10,
      printHeightCm: 10,
      headerCm: 8,
      footerCm: 5,
    });
    expect(zones.header.h).toBe(0.3);
    expect(zones.footer.h).toBe(0.3);
    expect(zones.body.h).toBeCloseTo(0.4, 10);
  });

  it('usa a altura da arte quando a altura impressa não existe', () => {
    const zones = computeSceneZones({
      id: 'x',
      artWidthCm: 10,
      artHeightCm: 20,
      printHeightCm: 0,
      headerCm: 2,
      footerCm: 2,
    });
    expect(zones.header.h).toBeCloseTo(0.1, 10);
  });
});
