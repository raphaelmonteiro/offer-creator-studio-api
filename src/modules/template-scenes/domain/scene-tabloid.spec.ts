import { createHash } from 'crypto';
import { directorInstructions } from './scene-director-prompt';
import { facesOfLayout, faceKeyOf, faceZones } from './scene-faces';
import { findSceneFormat, SceneFormatSpec } from './scene-formats';
import {
  acceptsTabloid,
  foldSourceOf,
  headerCmOf,
  logoSpace,
  resolveHeaderSize,
  sameZones,
  tabloidMeasures,
  tabloidZones,
} from './scene-tabloid';

const format = findSceneFormat('folheto-54x40') as SceneFormatSpec;
const SIZE = { widthPx: 3328, heightPx: 2480 };

describe('Zonas do jornal (Zonas no detalhe)', () => {
  it('Externa: cabeçalho só na capa, rodapé só na contracapa e faixa da dobra', () => {
    const zones = faceZones(format, 'outer');
    expect(zones.header.x).toBeCloseTo(0.535, 3);
    expect(zones.header.h).toBeCloseTo(0.15, 10);
    expect(zones.footer).toMatchObject({ x: 0, y: 0.9 });
    expect(zones.footer.w).toBeCloseTo(0.473, 3);
    expect(zones.fold?.x).toBeCloseTo(0.47296, 4);
    expect(zones.fold?.w).toBeCloseTo(0.05409, 4);
    expect(zones.body).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('Interna: cabeçalho e rodapé de altura 0 e a mesma faixa da dobra', () => {
    const inner = faceZones(format, 'inner');
    expect(inner.header.h).toBe(0);
    expect(inner.footer.h).toBe(0);
    expect(inner.fold).toEqual(faceZones(format, 'outer').fold);
  });

  it('as faces do layout e o 54x40 de uma face sem dobra', () => {
    expect(facesOfLayout('tabloid').map((face) => [face.index, face.key, face.label])).toEqual([
      [0, 'outer', 'Externa'],
      [1, 'inner', 'Interna'],
    ]);
    expect(faceKeyOf('tabloid', 1)).toBe('inner');
    expect(faceZones(format, 'single').fold).toBeUndefined();
    expect(acceptsTabloid('folheto-54x40')).toBe(true);
    expect(acceptsTabloid('folheto-27x40')).toBe(false);
  });

  it('sameZones compara campo a campo', () => {
    expect(sameZones(tabloidZones(format, 'outer'), tabloidZones(format, 'outer'))).toBe(true);
    expect(sameZones(tabloidZones(format, 'outer'), tabloidZones(format, 'outer', 8))).toBe(false);
    expect(sameZones(tabloidZones(format, 'outer'), faceZones(format, 'single'))).toBe(false);
  });
});

describe('Medidas em px do 54x40', () => {
  it('cabeçalho de 372, faixa do rodapé de 2232, dobra em 1664 e espaço da logo de 312', () => {
    expect(tabloidMeasures(tabloidZones(format, 'outer'), SIZE)).toEqual({
      width: 3328,
      height: 2480,
      headerEnd: 372,
      headerX: 1780,
      footerStart: 2232,
      footerEndX: 1574,
      foldX: 1664,
      foldFrom: 1574,
      foldTo: 1754,
      logoX: 1800,
      logoY: 30,
      logoSize: 312,
    });
  });

  it('o espaço da logo acompanha a altura do cabeçalho; o centro padrão é (1956, 186)', () => {
    const space = logoSpace(tabloidZones(format, 'outer'), SIZE);
    expect(space.centerX * 3328).toBeCloseTo(1956, 5);
    expect(space.centerY * 2480).toBeCloseTo(186, 5);
    expect(space.sidePx).toBe(312);
    expect(tabloidMeasures(tabloidZones(format, 'outer', 12), SIZE).headerEnd).toBe(744);
    expect(tabloidMeasures(tabloidZones(format, 'outer', 3), SIZE)).toMatchObject({
      headerEnd: 186,
      logoSize: 156,
    });
  });

  it('a dobra vai para o template como dado', () => {
    expect(foldSourceOf(tabloidZones(format, 'outer'), 3328)).toEqual({
      xPx: 1664,
      safeFromPx: 1574,
      safeToPx: 1754,
    });
    expect(foldSourceOf(faceZones(format, 'single'), 3328)).toBeUndefined();
  });
});

describe('Altura do cabeçalho (PV-T9)', () => {
  const resolve = (current: number, size: Parameters<typeof resolveHeaderSize>[1]) =>
    resolveHeaderSize(current, size, format);

  it('lê 6 cm nas zonas padrão e 8 cm com h 0,2', () => {
    expect(headerCmOf(tabloidZones(format, 'outer'), format)).toBe(6);
    expect(headerCmOf(tabloidZones(format, 'outer', 8), format)).toBe(8);
  });

  it('maior e menor andam 2 cm; o cm dito vale', () => {
    expect(resolve(6, { direction: 'maior' })).toEqual({
      kind: 'resize',
      fromCm: 6,
      toCm: 8,
      limit: null,
    });
    expect(resolve(6, { direction: 'menor' })).toMatchObject({ kind: 'resize', toCm: 4 });
    expect(resolve(6, { cm: 10, direction: null })).toMatchObject({ kind: 'resize', toCm: 10 });
  });

  it('Acima do teto: vai a 12 cm com o limite; abaixo do mínimo, a 3 cm', () => {
    expect(resolve(10, { cm: 15 })).toEqual({ kind: 'resize', fromCm: 10, toCm: 12, limit: 'max' });
    expect(resolve(4, { cm: 1 })).toEqual({ kind: 'resize', fromCm: 4, toCm: 3, limit: 'min' });
  });

  it('Já no limite: sem mudança', () => {
    expect(resolve(12, { direction: 'maior' })).toEqual({ kind: 'same', cm: 12, limit: 'max' });
    expect(resolve(3, { direction: 'menor' })).toEqual({ kind: 'same', cm: 3, limit: 'min' });
    expect(resolve(6, { cm: 6 })).toEqual({ kind: 'same', cm: 6, limit: null });
  });

  it('sem tamanho nem direção não decide', () => {
    expect(resolve(6, null)).toEqual({ kind: 'unclear' });
    expect(resolve(6, { cm: null, direction: null })).toEqual({ kind: 'unclear' });
  });
});

describe('Prompts do Diretor das outras cenas intactos', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');

  it('single e front_back têm o mesmo hash de antes; o jornal ganha as linhas novas', () => {
    expect(sha(directorInstructions('single'))).toBe(
      'e93e35b87a892602179881685dbea45e47f32a63351e233d07a61f8356c2b529',
    );
    expect(sha(directorInstructions('front_back'))).toBe(
      '504631020bcd0fdb90c8c54de51d39870891e80e00c62089f62f448c71fd0c8f',
    );
    const tabloid = directorInstructions('tabloid');
    expect(tabloid).toContain('tamanho_cabecalho');
    expect(tabloid).toContain('header_size');
    expect(tabloid).toContain('Classes de turn_kind (14)');
    expect(directorInstructions('single')).not.toContain('tamanho_cabecalho');
    expect(directorInstructions('front_back')).not.toContain('header_size');
  });
});
