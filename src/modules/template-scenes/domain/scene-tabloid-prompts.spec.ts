import { faceZones } from './scene-faces';
import { findSceneFormat, SceneFormatSpec } from './scene-formats';
import {
  buildInnerPrompt,
  buildOuterPrompt,
  tabloidPreservationSentence,
  tabloidRegionText,
} from './scene-tabloid-prompts';
import { tabloidZones } from './scene-tabloid';

const format = findSceneFormat('folheto-54x40') as SceneFormatSpec;
const base = { format, widthPx: 3328, heightPx: 2480, zones: faceZones(format, 'outer') };

describe('Prompt do 54x40 (Externa)', () => {
  it('traz as medidas, o pedido literal e a linha de texto, sem ano', () => {
    const prompt = buildOuterPrompt({
      ...base,
      request: 'jornal de aniversário, festivo, vermelho e dourado',
      exactText: ['ANIVERSÁRIO'],
    });
    expect(prompt).toMatchSnapshot();
    expect(prompt).not.toMatch(/20\d\d/);
  });

  it('fundo rico e contínuo; faixa do rodapé opaca com fim reto na dobra; logo com espaço vazio (D-9)', () => {
    const prompt = buildOuterPrompt({
      ...base,
      request: 'tema',
      zones: faceZones(format, 'outer'),
    });
    expect(prompt).toContain('Never a flat blank wash');
    expect(prompt).toContain('along ALL the outer edges and corners of BOTH halves');
    expect(prompt).toContain('solid, opaque band');
    expect(prompt).toContain('clean straight end at x = 1574 px');
    expect(prompt).toContain('It never fades, blurs or dissolves');
    expect(prompt).toContain('the header artwork starts at x = 2160');
    expect(prompt).not.toMatch(
      /calm, uniform background|fades softly|no objects and no illustration/,
    );
  });

  it('Externa sem texto pedido proíbe qualquer texto', () => {
    const prompt = buildOuterPrompt({ ...base, request: 'jornal de hortifrúti, verde e fresco' });
    expect(prompt).toContain('Text: no text, no letters, no numbers, no logo, no watermark.');
    expect(prompt).not.toContain('exact Portuguese text');
  });

  it('a imagem nova leva os itens em aberto; a altura do cabeçalho acompanha a versão', () => {
    const prompt = buildOuterPrompt({
      ...base,
      zones: tabloidZones(format, 'outer', 10),
      request: 'tema',
      openItems: ['balões dourados.'],
    });
    expect(prompt).toContain('y from 0 to 620 px');
    expect(prompt).toContain('never lower than 620 px');
    expect(prompt).toContain('y = 496 px or higher');
    expect(prompt).toContain('Other client requests still open (Portuguese): balões dourados.');
  });
});

describe('Prompt da Interna (derivação)', () => {
  it('é fixo: sem pedido, sem ano, com a frase sem calha', () => {
    const prompt = buildInnerPrompt({ ...base, zones: faceZones(format, 'inner') });
    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain('Do NOT draw a gutter');
    expect(prompt).toContain('the same decorative language as the outer side');
    expect(prompt).toContain('along ALL four outer edges and corners');
    expect(prompt).not.toMatch(/no objects, no illustration|plain, even background/);
    expect(prompt).not.toMatch(/20\d\d|Client request/);
  });
});

describe('Frases de preservação e região do jornal', () => {
  it('Externa e Interna levam a frase da face; texto pedido tira a parte "sem texto"', () => {
    const outer = tabloidPreservationSentence('outer', { ...base, withClientText: false });
    expect(outer).toContain('above y = 372 px');
    expect(outer).toContain('x < 1574 px, y ≥ 2232 px');
    expect(outer).toContain('Do not add any text, letters, numbers or logos.');
    const inner = tabloidPreservationSentence('inner', {
      ...base,
      zones: faceZones(format, 'inner'),
      withClientText: true,
    });
    expect(inner).toContain('Do NOT draw a gutter, book-spine shadow');
    expect(inner).not.toContain('Do not add any text');
  });

  it.each([
    [
      'header',
      null,
      'only inside the cover header in the right half: x from 1780 to 3328 px, y < 372 px.',
    ],
    [
      'footer',
      'right',
      'only inside the footer band of the back cover: x from 0 to 1574 px, y ≥ 2232 px.',
    ],
    ['body', 'left', 'only on the back cover (left half, x < 1574 px), above the footer band.'],
    ['body', 'right', 'only on the front cover (right half, x > 1754 px), below the header.'],
  ] as const)('Externa %s %s', (zone, side, expected) => {
    expect(tabloidRegionText('outer', { ...base, zone, side })).toBe(expected);
  });

  it('Interna: lados como páginas 2 e 3', () => {
    const inner = { ...base, zones: faceZones(format, 'inner'), zone: 'body' as const };
    expect(tabloidRegionText('inner', { ...inner, side: 'left' })).toContain('page 2 (left half');
    expect(tabloidRegionText('inner', { ...inner, side: 'right' })).toContain('page 3 (right half');
  });
});
