import { computeSceneZones, findSceneFormat } from './scene-formats';
import {
  expectedLines,
  nextPaintedLines,
  paintedMetricsOf,
  readPaintedLines,
  roundZone,
} from './scene-painted-text';

const zones = computeSceneZones(findSceneFormat('folheto-20x27')!);

describe('roundZone', () => {
  it.each([
    ['header', 'header'],
    ['footer', 'footer'],
    ['body', 'body'],
    ['whole', 'whole'],
    ['marked', 'whole'],
  ] as const)('sem marcação, region.zone %s vale %s', (regionZone, expected) => {
    expect(roundZone({ regionZone, marking: null, zones })).toBe(expected);
  });

  it('com marcação, vale a zona que contém o centro da caixa, seja qual for region.zone', () => {
    const at = (y: number, h: number) =>
      roundZone({ regionZone: 'marked', marking: { x: 0.1, y, w: 0.5, h }, zones });
    expect(at(0.01, 0.05)).toBe('header');
    expect(at(0.4, 0.1)).toBe('body');
    expect(at(0.93, 0.05)).toBe('footer');
    expect(roundZone({ regionZone: 'whole', marking: { x: 0, y: 0, w: 1, h: 0.08 }, zones })).toBe(
      'header',
    );
  });
});

describe('expectedLines', () => {
  const promo = { text: 'Promoção de Páscoa', zone: 'footer' as const };

  it('linha herdada de outra zona é mantida, depois das linhas da rodada', () => {
    expect(expectedLines({ lines: ['Frete grátis'], zone: 'header' }, [promo])).toEqual([
      { text: 'Frete grátis', zone: 'header', inherited: false },
      { ...promo, inherited: true },
    ]);
  });

  it('na mesma zona a linha herdada é substituída; `whole` substitui todas as que têm zona', () => {
    expect(
      expectedLines({ lines: ['Oferta'], zone: 'footer' }, [promo]).map((l) => l.text),
    ).toEqual(['Oferta']);
    const other = { text: 'Frete grátis', zone: 'header' as const };
    expect(
      expectedLines({ lines: ['Oferta'], zone: 'whole' }, [promo, other]).map((l) => l.text),
    ).toEqual(['Oferta']);
  });

  it('linha sem zona gravada é sempre mantida, até com `whole`', () => {
    const old = { text: 'Antiga' };
    expect(expectedLines({ lines: ['Oferta'], zone: 'whole' }, [old]).map((l) => l.text)).toEqual([
      'Oferta',
      'Antiga',
    ]);
  });

  it('sem texto novo, tudo o que foi herdado é mantido', () => {
    expect(expectedLines({ lines: [], zone: 'footer' }, [promo])).toEqual([
      { ...promo, inherited: true },
    ]);
  });

  it('a linha repetida pela rodada vale uma vez, com a zona da rodada', () => {
    expect(expectedLines({ lines: ['Promoção  de Páscoa'], zone: 'header' }, [promo])).toEqual([
      { text: 'Promoção  de Páscoa', zone: 'header', inherited: false },
    ]);
  });
});

describe('nextPaintedLines', () => {
  const lines = expectedLines({ lines: ['Frete grátis'], zone: 'header' }, [
    { text: 'Promoção de Páscoa', zone: 'footer' },
    { text: 'Antiga', unchecked: true },
  ]);
  const ok = (asked: string, read = asked) => ({ asked, read, ok: asked === read });

  it('grava as linhas lidas iguais, com a zona; a herdada lida vazia sai (PV-83)', () => {
    const gone = { asked: 'Antiga', read: '', ok: true, gone: true };
    expect(nextPaintedLines(lines, [ok('Frete grátis'), ok('Promoção de Páscoa'), gone])).toEqual([
      { text: 'Frete grátis', zone: 'header' },
      { text: 'Promoção de Páscoa', zone: 'footer' },
    ]);
  });

  it('a linha lida diferente não é gravada', () => {
    expect(
      nextPaintedLines(lines, [
        ok('Frete grátis', 'Frete gratis'),
        ok('Promoção de Páscoa'),
        ok('Antiga'),
      ]),
    ).toEqual([{ text: 'Promoção de Páscoa', zone: 'footer' }, { text: 'Antiga' }]);
  });

  it('sem leitura, a linha da rodada fica não conferida e a herdada segue como estava (PV-94)', () => {
    expect(nextPaintedLines(lines, null)).toEqual([
      { text: 'Frete grátis', zone: 'header', unchecked: true },
      { text: 'Promoção de Páscoa', zone: 'footer' },
      { text: 'Antiga', unchecked: true },
    ]);
  });
});

describe('metrics.paintedText', () => {
  it('lê a forma antiga e ignora o que não é linha', () => {
    expect(readPaintedLines(['A', { text: 'B', zone: 'body' }, { text: ' ' }, 3, null])).toEqual([
      { text: 'A' },
      { text: 'B', zone: 'body' },
    ]);
    expect(readPaintedLines(undefined)).toEqual([]);
  });

  it('o campo copiado para a versão que não muda a imagem: só quando há linhas', () => {
    expect(paintedMetricsOf({ metrics: { paintedText: ['A'] } })).toEqual({
      paintedText: [{ text: 'A' }],
    });
    expect(paintedMetricsOf({ metrics: {} })).toEqual({});
    expect(paintedMetricsOf({ metrics: { paintedText: [] } })).toEqual({});
  });
});
