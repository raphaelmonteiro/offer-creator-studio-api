import { faceZones } from '../domain/scene-faces';
import { findSceneFormat, SceneFormatSpec } from '../domain/scene-formats';
import { describeLayerDiff } from '../domain/scene-layer-diff';
import { tabloidZones } from '../domain/scene-tabloid';
import { SceneElement } from '../domain/scene.types';
import { fitLogosToHeader } from './scene-header-logo';
import { applyLayerActions } from './scene-layer-actions';

const format = findSceneFormat('folheto-54x40') as SceneFormatSpec;
const size = { widthPx: 3328, heightPx: 2480 };
const attachment = { id: 'logo-1', url: '/logo.png', width: 400, height: 200 };

const addLogo = (
  zones: ReturnType<typeof faceZones>,
  position: { side: 'left' | 'center' | 'right'; zone: 'header' | 'body' | 'footer' },
) => {
  const result = applyLayerActions([{ type: 'add_logo', assetId: 'logo-1', ...position }], {
    zones,
    ...size,
    elements: [],
    attachments: [attachment],
  });
  if (result.ok === false) throw new Error(result.reply);
  return result.elements[0];
};

describe('Logo no espaço da capa (PV-T4)', () => {
  it('no cabeçalho da Externa: centrada em (1956, 186) com o lado maior até 312 px', () => {
    const logo = addLogo(faceZones(format, 'outer'), { side: 'left', zone: 'header' });
    expect(logo.x * 3328).toBeCloseTo(1956, 5);
    expect(logo.y * 2480).toBeCloseTo(186, 5);
    expect(logo.w * 3328).toBeCloseTo(312, 5);
  });

  it('o espaço acompanha a altura do cabeçalho; logo alta limita a altura', () => {
    const logo = addLogo(tabloidZones(format, 'outer', 12), { side: 'right', zone: 'header' });
    expect(logo.y * 2480).toBeCloseTo(372, 5);
    expect(logo.w * 3328).toBeCloseTo(624, 5);
  });

  it('no miolo e no rodapé o lado vale dentro da zona (contracapa ou capa)', () => {
    const zones = faceZones(format, 'outer');
    expect(addLogo(zones, { side: 'left', zone: 'body' }).x).toBeCloseTo(0.19, 10);
    expect(addLogo(zones, { side: 'right', zone: 'body' }).x).toBeCloseTo(0.81, 10);
    expect(addLogo(zones, { side: 'left', zone: 'footer' }).x).toBeLessThan(0.473);
  });

  it('na Interna (sem cabeçalho) e nas outras cenas, a regra do miolo de sempre', () => {
    expect(addLogo(faceZones(format, 'inner'), { side: 'left', zone: 'header' }).w).toBe(0.3);
    const single = addLogo(faceZones(format, 'single'), { side: 'left', zone: 'header' });
    expect(single.w).toBe(0.3);
    expect(single.x).toBeCloseTo(0.19, 10);
  });
});

describe('Logo acompanha o cabeçalho que diminui (PV-T11)', () => {
  const logoAt = (over: Partial<SceneElement>): SceneElement => ({
    id: 'l',
    kind: 'logo',
    name: 'Logo 1',
    x: 1956 / 3328,
    y: 186 / 2480,
    w: 312 / 3328,
    aspect: 1,
    rotation: 0,
    z: 1,
    ...over,
  });
  const ctx = (toCm: number, fromCm = 6) => ({
    ...size,
    formatId: 'folheto-54x40',
    zones: tabloidZones(format, 'outer', toCm),
    headerResize: { fromCm, toCm },
  });

  it('ao diminuir, a logo que sai do cabeçalho vai para o novo quadrado', () => {
    const fitted = fitLogosToHeader([logoAt({})], ctx(3));
    expect(fitted).not.toBeNull();
    const [logo] = fitted as SceneElement[];
    expect(logo.w * 3328).toBeCloseTo(156, 5);
    expect(logo.y * 2480).toBeCloseTo(15 + 78, 5);
  });

  it('ao aumentar, ou com logo fora do cabeçalho ou na contracapa, nada muda', () => {
    expect(fitLogosToHeader([logoAt({})], ctx(8, 6))).toBeNull();
    expect(fitLogosToHeader([logoAt({ y: 0.6 })], ctx(3))).toBeNull();
    expect(fitLogosToHeader([logoAt({ x: 0.2 })], ctx(3))).toBeNull();
  });
});

describe('Onde a camada está no jornal', () => {
  const zones = faceZones(format, 'outer');
  const layer = (x: number, y: number): SceneElement =>
    ({
      id: 'a',
      kind: 'text',
      name: 'Texto 1',
      text: 'Oi',
      x,
      y,
      w: 0.2,
      aspect: 3,
    }) as SceneElement;

  it('o cabeçalho é só da capa e o rodapé só da contracapa', () => {
    const where = (x: number, y: number) => describeLayerDiff([], [layer(x, y)], zones).text;
    expect(where(0.8, 0.05)).toContain('no cabeçalho');
    expect(where(0.2, 0.05)).toContain('no miolo');
    expect(where(0.2, 0.95)).toContain('no rodapé');
    expect(where(0.8, 0.95)).toContain('no miolo');
  });
});
