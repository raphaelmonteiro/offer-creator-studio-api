import { FICHA_NAVARRO, FICHA_R1, FICHA_R2 } from '../testing/reference-fichas';
import { faceZones } from './scene-faces';
import { computeSceneZones, findSceneFormat, SceneFormatSpec } from './scene-formats';
import { sanitizeConcept } from './scene-reference-concept';
import { buildConceptPrompt, buildReferencePrompt } from './scene-reference-prompts';
import { buildOuterPrompt } from './scene-tabloid-prompts';
import { nativeSizeOfFormat } from './scene-format-size';

const FICHAS = { R1: FICHA_R1, R2: FICHA_R2, Navarro: FICHA_NAVARRO };
const FORMATS = ['folheto-27x40', 'folheto-20x27', 'folheto-54x40'] as const;

function promptFor(ficha: unknown, formatId: string): string {
  const format = findSceneFormat(formatId) as SceneFormatSpec;
  const size = nativeSizeOfFormat(format) as { width: number; height: number };
  return buildReferencePrompt({
    artWidthCm: format.artWidthCm,
    artHeightCm: format.artHeightCm,
    widthPx: size.width,
    heightPx: size.height,
    zones: computeSceneZones(format),
    concept: sanitizeConcept(ficha).concept,
  });
}

describe('buildReferencePrompt: snapshots das 3 fichas do estudo', () => {
  for (const [name, ficha] of Object.entries(FICHAS)) {
    for (const formatId of FORMATS) {
      it(`${name} em ${formatId}`, () => {
        expect(promptFor(ficha, formatId)).toMatchSnapshot();
      });
    }
  }
});

describe('buildReferencePrompt: medidas e proibições', () => {
  it('27x40: cabeçalho de 526 px com folga em 447, sem medalhão e com tinta', () => {
    const prompt = promptFor(FICHA_R1, 'folheto-27x40');
    expect(prompt).toContain('2352x3504 px');
    expect(prompt).toContain('strictly confined to the top 526 px');
    expect(prompt).toContain('above y = 447 px');
    expect(prompt).toContain('never pure white');
    expect(prompt).toContain('no medallions');
  });

  it('altura do cabeçalho da ficha é ignorada: 20x27 usa 740 px e não cita 27%', () => {
    const prompt = promptFor(FICHA_NAVARRO, 'folheto-20x27');
    expect(prompt).toContain('strictly confined to the top 740 px');
    expect(prompt).toContain('above y = 629 px');
    expect(prompt).not.toContain('27%');
  });

  it('54x40 de uma face: 3328x2480, cabeçalho em 372 px com folga em 316, sem dobra', () => {
    const prompt = promptFor(FICHA_R2, 'folheto-54x40');
    expect(prompt).toContain('3328x2480 px');
    expect(prompt).toContain('strictly confined to the top 372 px');
    expect(prompt).toContain('above y = 316 px');
    expect(prompt).not.toMatch(/fold/i);
  });

  it('Navarro (D-1): "medallion" só aparece nas proibições', () => {
    const prompt = promptFor(FICHA_NAVARRO, 'folheto-20x27');
    const outside = prompt
      .split('\n')
      .filter((line) => !/^Original background|^The attached reference/.test(line))
      .join('\n');
    expect(outside).not.toMatch(/medallion/i);
    expect(prompt).toContain('no medallions');
  });

  it('corpo com a tinta da paleta: 10% do cabeçalho com branco, "light"', () => {
    const ficha = {
      theme: 'x',
      signature_elements: [],
      palette: [
        { hex: '#FFFFFF', name_pt: 'branco', role: 'body background' },
        { hex: '#1739D2', name_pt: 'azul', role: 'header' },
      ],
    };
    const prompt = promptFor(ficha, 'folheto-27x40');
    expect(prompt).toContain('light azul #E8EBFB');
    expect(prompt).toContain('never pure white');
  });

  it('faixa de baixo só existe com elementos em bottom edge', () => {
    expect(promptFor(FICHA_NAVARRO, 'folheto-20x27')).toContain('Along the bottom 493 px, a thin');
    expect(promptFor(FICHA_R1, 'folheto-27x40')).not.toContain('Along the bottom');
  });

  it('grupos vazios viram frases fixas e com menos de 3 cores o prompt não cita hex', () => {
    const ficha = {
      theme: 'outubro',
      signature_elements: [],
      palette: [{ hex: '#112233', name_pt: 'azul', role: 'header' }],
    };
    const prompt = promptFor(ficha, 'folheto-27x40');
    expect(prompt).toContain('Keep the header simple.');
    expect(prompt).toContain('No decorations on the edges.');
    expect(prompt).toContain('palette (azul)');
  });
});

describe('Externa do jornal com referência (D-2)', () => {
  const format = findSceneFormat('folheto-54x40') as SceneFormatSpec;
  const base = { format, widthPx: 3328, heightPx: 2480, zones: faceZones(format, 'outer') };

  it('snapshot com a ficha do R2: conceito no lugar do pedido, tinta, parágrafo e sem texto', () => {
    const concept = sanitizeConcept(FICHA_R2).concept;
    const prompt = buildOuterPrompt({ ...base, request: '', concept });
    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain('Art concept from the reference flyer');
    expect(prompt).not.toContain('Client request');
    expect(prompt).toContain('y from 0 to 372 px');
    expect(prompt).toContain('y = 298 px or higher');
    expect(prompt).toContain('never pure white');
    expect(prompt).toContain('No badges, no medallions, no seals');
    expect(prompt).toContain('Text: no text, no letters, no numbers, no logo, no watermark.');
  });

  it('o texto exato do plano não entra na Externa por referência', () => {
    const concept = sanitizeConcept(FICHA_R1).concept;
    const prompt = buildOuterPrompt({ ...base, request: '', exactText: ['OFERTAS'], concept });
    expect(prompt).not.toContain('OFERTAS');
  });

  it('sem concept o prompt da Externa não tem conceito nem parágrafo de referência', () => {
    const prompt = buildOuterPrompt({ ...base, request: 'jornal de aniversário' });
    expect(prompt).not.toContain('Art concept');
    expect(prompt).not.toContain('reference image');
    expect(prompt).toContain('Client request (Portuguese');
  });
});

describe('buildConceptPrompt', () => {
  it('traz a regra do selo e do medalhão da logo (D-1) e is_retail_flyer', () => {
    const prompt = buildConceptPrompt();
    expect(prompt).toContain(
      'any badge, medallion, seal, emblem, rosette, crest, stamp or round frame',
    );
    expect(prompt).toContain('"is_retail_flyer": true|false');
    expect(prompt).not.toContain('Client correction');
  });

  it('a correção do cliente leva o texto e a ficha limpa anterior', () => {
    const previous = sanitizeConcept(FICHA_R2).concept;
    const prompt = buildConceptPrompt({ note: 'não tem  bandeirinha,\ntira', previous });
    expect(prompt).toContain(
      'Client correction (Brazilian Portuguese), apply it to the concept: "não tem bandeirinha, tira".',
    );
    expect(prompt).toContain(`The previous concept was: ${JSON.stringify(previous)}.`);
  });
});
