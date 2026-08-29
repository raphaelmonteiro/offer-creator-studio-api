import { KitCanonicalDesc } from './kit-prompts';
import { buildActionVideoPrompt, buildKeyframePrompt } from './mc-scene-prompts';

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
