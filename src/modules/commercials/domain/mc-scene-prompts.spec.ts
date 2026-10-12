import { KitCanonicalDesc } from './kit-prompts';
import {
  MC_KIT_SOURCES,
  MC_KIT_STYLES,
  McKitSource,
  McKitStyle,
  STYLE_BLOCKS,
} from './mc-kit-identity';
import {
  buildActionVideoPrompt,
  buildKeyframePrompt,
  buildKeyframePromptV2,
} from './mc-scene-prompts';

describe('mc-scene-prompts — prompt do keyframe e do motor de ação (plano §5.1/§5.2)', () => {
  const desc: KitCanonicalDesc = {
    traits: ['capivara antropomórfica', 'avental vermelho'],
    colors: ['#FF4500'],
    style: '3D cartoon',
    doNots: ['nunca mudar a espécie'],
    accessories: ['green shopping basket'],
  };

  it('ancora ação, enquadramento e a regra de ouro de não desenhar texto/preço', () => {
    const prompt = buildKeyframePrompt('O mascote acena', desc, '9:16');
    expect(prompt).toContain('O mascote acena');
    expect(prompt).toContain('Vertical 9:16');
    expect(prompt).toContain('No text, no numbers, no price tags');
  });

  it.each([
    ['16:9', 'Horizontal 16:9'],
    ['1:1', 'Square 1:1'],
    ['4:5', 'Vertical 4:5 composition (portrait feed framing)'],
  ])('respeita o aspecto %s', (aspect, expected) => {
    expect(buildKeyframePrompt('ação', null, aspect)).toContain(expected);
  });

  // v1.15 — sem esta regra o mascote carregava a cesta da arte original em
  // TODAS as cenas, porque o prop entrava como traço na ficha.
  it('acessório é prop opcional: só entra se a ação da cena pedir', () => {
    const prompt = buildKeyframePrompt('O mascote acena', desc, '9:16');
    expect(prompt).toContain('Removable props — include ONLY if the scene action');
    expect(prompt).toContain('green shopping basket');
    expect(prompt).toContain('hands are empty');
  });

  it('ajuste do usuário viaja da ficha para o keyframe', () => {
    const prompt = buildKeyframePrompt(
      'O mascote acena',
      {
        ...desc,
        adjustments: 'Remove the basket from his hands',
      },
      '9:16',
    );
    expect(prompt).toContain('User adjustments (highest priority, follow strictly)');
  });

  it('sem ficha, só o bloco base — nada de linha órfã de props', () => {
    const prompt = buildKeyframePrompt('O mascote acena', null, '9:16');
    expect(prompt).not.toContain('Character sheet');
    expect(prompt).not.toContain('Removable props');
  });

  it('prompt de ação normaliza pontuação e carrega o sufixo de preservação', () => {
    expect(buildActionVideoPrompt('  The mascot   waves  ')).toBe(
      'The mascot waves. Keep exactly the same character design, colors, proportions and ' +
        'outfit unchanged throughout. One continuous, smooth, natural action. Static camera, ' +
        'no text or logos on screen.',
    );
    expect(buildActionVideoPrompt('The mascot waves!')).toContain('waves! Keep exactly');
  });
});

/**
 * Change video-formatos-personagem (D5): o estilo fixo do kit entra nos dois
 * builders de keyframe como bloco (fim do hack de `adjustments`); origem
 * `logo` deixa de proibir "logos" no legado. Snapshots = contrato.
 */
describe('mc-scene-prompts — estilo fixo e origem do kit (D5)', () => {
  const desc: KitCanonicalDesc = {
    traits: ['friendly capybara', 'red apron'],
    colors: ['#FF4500'],
    style: 'hand-drawn 2D sketch',
    doNots: ['never change the species'],
    accessories: ['green shopping basket'],
    adjustments: 'Make the eyes a bit bigger',
  };
  const matrix = MC_KIT_STYLES.flatMap((style) =>
    MC_KIT_SOURCES.map((source) => [style, source] as const),
  );
  const both = (identity: { style?: McKitStyle | null; source?: McKitSource | null }) => [
    buildKeyframePrompt('The mascot waves at the camera', desc, '9:16', identity),
    buildKeyframePromptV2({
      initialFrame: 'The mascot stands by the shelf, smiling',
      lang: 'en',
      canonicalDesc: desc,
      aspectRatio: '9:16',
      safeArea: 'lower_third',
      environmentDescription: null,
      productName: null,
      ...identity,
    }),
  ];

  it.each(matrix)('snapshot keyframe legado + v2: estilo %s × origem %s', (style, source) => {
    expect(both({ style, source })).toMatchSnapshot();
  });

  it('bloco de estilo nos dois builders; o estilo livre da ficha sai; ajustes perdem a prioridade', () => {
    for (const style of MC_KIT_STYLES) {
      for (const prompt of both({ style })) {
        expect(prompt).toContain(STYLE_BLOCKS[style]);
        expect(prompt).not.toContain('- Style: hand-drawn 2D sketch');
        expect(prompt).not.toContain('highest priority');
        expect(prompt).toContain('never override the fixed rendering style above');
      }
    }
  });

  it('sem estilo (kit anterior) nada muda nos dois builders', () => {
    const [legacy, v2] = both({});
    expect(legacy).toBe(buildKeyframePrompt('The mascot waves at the camera', desc, '9:16'));
    expect(legacy).toBe(both({ style: null, source: 'mascot' })[0]);
    expect(legacy).toContain('- Style: hand-drawn 2D sketch');
    expect(legacy).toContain('User adjustments (highest priority, follow strictly)');
    expect(v2).not.toContain('Rendering style');
    expect(v2).toContain('User adjustments (highest priority, follow strictly)');
  });

  it('origem logo no keyframe legado: cai o "no logos", fica a proibição de texto adicionado', () => {
    const [legacy, v2] = both({ source: 'logo', style: 'realistic' });
    expect(legacy).not.toContain('no logos');
    expect(legacy).toContain('No added text, numbers, price tags or watermarks');
    expect(legacy).toContain("character's own logo design stay as in the references");
    // o v2 já preservava emblemas do personagem aprovado — texto inalterado
    expect(v2).toContain('Emblems or marks that are part of the approved character design stay');
  });
});
