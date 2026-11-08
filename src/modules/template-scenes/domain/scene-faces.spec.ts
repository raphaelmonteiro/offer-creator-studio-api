import {
  acceptsFrontBack,
  backPreservationSentence,
  buildBackPrompt,
  effectiveZone,
  faceKeyOf,
  facesOfLayout,
  faceZones,
  FRONT_BACK_FORMAT_IDS,
  zoneRect,
} from './scene-faces';
import { findSceneFormat, SCENE_FORMAT_IDS } from './scene-formats';
import { nativeSizeOfFormat } from './scene-format-size';
import { SceneFormatSpec } from './scene-formats';

const format = (id: string): SceneFormatSpec => findSceneFormat(id) as SceneFormatSpec;

describe('faceZones', () => {
  it.each(FRONT_BACK_FORMAT_IDS)('zonas das três chaves em %s', (id) => {
    const f = format(id);
    const single = faceZones(f, 'single');
    const front = faceZones(f, 'front');
    const back = faceZones(f, 'back');

    expect(front.header).toEqual(single.header);
    expect(front.footer.h).toBe(0);
    expect(front.footer.y).toBe(1);
    expect(front.body.y).toBeCloseTo(single.header.h, 10);
    expect(front.body.y + front.body.h).toBeCloseTo(1, 10);

    expect(back.header.h).toBe(0);
    expect(back.header.y).toBe(0);
    expect(back.footer).toEqual(single.footer);
    expect(back.body.y).toBe(0);
    expect(back.body.y + back.body.h).toBeCloseTo(back.footer.y, 10);
  });

  it('single é igual às zonas do formato', () => {
    const f = format('folheto-27x54');
    expect(faceZones(f, 'single').footer.h).toBeCloseTo(4 / 54, 10);
  });
});

describe('formatos que aceitam frente e verso (D-9)', () => {
  it('são os 7 em retrato e nenhum em paisagem', () => {
    expect([...FRONT_BACK_FORMAT_IDS].sort()).toEqual(
      [
        'folheto-10x13',
        'folheto-20x27',
        'folheto-27x30',
        'folheto-27x40',
        'folheto-27x54',
        'revista-13x19.5',
        'revista-20x26.5',
      ].sort(),
    );
    for (const id of ['folheto-55x36', 'folheto-54x40', 'folheto-54x30']) {
      expect(acceptsFrontBack(id)).toBe(false);
    }
    for (const id of FRONT_BACK_FORMAT_IDS) expect(SCENE_FORMAT_IDS).toContain(id);
  });
});

describe('faces do layout', () => {
  it('single tem uma face sem rótulo; frente e verso tem duas', () => {
    expect(facesOfLayout('single')).toEqual([{ index: 0, key: 'single', label: null }]);
    expect(facesOfLayout('front_back').map((face) => [face.index, face.key, face.label])).toEqual([
      [0, 'front', 'Frente'],
      [1, 'back', 'Verso'],
    ]);
    expect(faceKeyOf('front_back', 1)).toBe('back');
    expect(faceKeyOf('single', 0)).toBe('single');
  });
});

describe('zona que a face não tem (PV-9)', () => {
  it('rodapé na frente e cabeçalho no verso viram miolo; o resto passa', () => {
    const f = format('folheto-27x40');
    const front = faceZones(f, 'front');
    const back = faceZones(f, 'back');
    expect(effectiveZone('footer', front)).toBe('body');
    expect(effectiveZone('header', front)).toBe('header');
    expect(effectiveZone('header', back)).toBe('body');
    expect(effectiveZone('footer', back)).toBe('footer');
    expect(effectiveZone('marked', front)).toBe('marked');
    expect(zoneRect(front, 'footer')).toEqual(front.body);
  });
});

describe('Prompt do 27x40', () => {
  const f = format('folheto-27x40');
  const size = nativeSizeOfFormat(f) as { width: number; height: number };
  const input = {
    format: f,
    widthPx: size.width,
    heightPx: size.height,
    zones: faceZones(f, 'back'),
  };

  it('tem o tamanho nativo, o topo calmo de 0 a 171 e o rodapé de 3154 a 3504', () => {
    expect(size).toEqual({ width: 2352, height: 3504 });
    expect(buildBackPrompt(input)).toMatchInlineSnapshot(`
"Edit the provided image. It is the FRONT of a flyer sheet. Create the BACK side of the same sheet from it: the same printed piece, same artwork family.
Format: 27.5 x 41 cm sheet art (27 x 40 cm trim plus bleed), portrait, 2352x3504 px, filling the whole canvas edge to edge. About 85 px per cm.
Keep from the provided image: the color palette, the lighting, the motifs style and the texture, so both sides look like one printed piece.
Change: remove the header, the title and every decorative object of the header completely. The back has NO header, NO title and NO text of any kind. The top 2 cm (y from 0 to about 171 px) is calm plain background with no objects. The lowest 4 cm (y from about 3154 to 3504 px) is a calm plain band, with no objects and no pattern, because the store footer is placed there later. Everything between is free calm background for product cards, with only very discreet motifs at the edges.
Rules: no readable text, no letters or numbers, no logos, no prices, no real brands, no identifiable people, no store name. One continuous picture without panels, strips or frames."
`);
  });

  it('não leva texto do cliente, ano nem item do brief', () => {
    const prompt = buildBackPrompt(input);
    expect(prompt).not.toMatch(/20\d\d/);
    expect(prompt).not.toMatch(/Pedido|cliente|Páscoa/i);
  });

  it('os outros formatos trazem as próprias faixas', () => {
    const other = format('folheto-20x27');
    const otherSize = nativeSizeOfFormat(other) as { width: number; height: number };
    const prompt = buildBackPrompt({
      format: other,
      widthPx: otherSize.width,
      heightPx: otherSize.height,
      zones: faceZones(other, 'back'),
    });
    expect(prompt).toContain(`${otherSize.width}x${otherSize.height} px`);
    expect(prompt).toContain('20.5 x 27.5 cm sheet art (20 x 27 cm trim plus bleed)');
    expect(prompt).toContain('The lowest 4 cm (y from about 2835 to 3328 px)');
  });
});

describe('Frase de preservação no verso', () => {
  const f = format('folheto-27x40');
  const base = { format: f, widthPx: 2352, heightPx: 3504, zones: faceZones(f, 'back') };

  it('sem texto pedido, proíbe texto novo', () => {
    expect(backPreservationSentence({ ...base, withClientText: false })).toBe(
      'This is the BACK side of the sheet: it has no header and no title. Do not add a header or a title. Keep the top 2 cm (y from 0 to about 171 px) and the lowest 4 cm (y from about 3154 px) calm, with no objects. Do not add any text, letters, numbers or logos.',
    );
  });

  it('com texto pedido, a parte "sem texto" sai', () => {
    const sentence = backPreservationSentence({ ...base, withClientText: true });
    expect(sentence).toContain('Do not add a header or a title.');
    expect(sentence).not.toContain('Do not add any text');
  });
});
