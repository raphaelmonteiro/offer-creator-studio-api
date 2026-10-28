import { buildTalkPrompt, TALK_PROMPT_SUFFIX } from './mc-talk-prompts';

describe('buildTalkPrompt — modo sem fundo (video-mascote-transparente, D13)', () => {
  it('sem modo sem fundo o texto é o de sempre, byte a byte', () => {
    expect(buildTalkPrompt()).toBe(TALK_PROMPT_SUFFIX);
    expect(buildTalkPrompt(null, null)).toBe(TALK_PROMPT_SUFFIX);
    expect(buildTalkPrompt('Waves at the start')).toBe(`Waves at the start. ${TALK_PROMPT_SUFFIX}`);
    expect(TALK_PROMPT_SUFFIX).toContain('Static medium shot');
    expect(TALK_PROMPT_SUFFIX).toContain('Keep the plain solid background unchanged.');
  });

  it('corpo com chave verde: figura inteira, fundo verde idêntico em todo quadro, proibição de texto íntegra e na roupa', () => {
    const prompt = buildTalkPrompt('Waves.', { keyColor: '#00B140', framing: 'corpo' });
    expect(prompt).toMatch(/^Waves\. /);
    expect(prompt).toContain('Static shot that keeps the whole figure in frame');
    expect(prompt).not.toContain('Static medium shot');
    expect(prompt).toContain(
      'plain solid green background exactly the same flat color in every frame',
    );
    expect(prompt).toContain(
      'no shadow, gradient, vignette, floor, reflection or camera light change',
    );
    expect(prompt).toContain('Absolutely no text anywhere in the frame');
    expect(prompt).toContain('no captions, no subtitles, no signs, no banners, no price tags');
    expect(prompt).toContain(
      "no logos other than the character's own design, including on the clothing.",
    );
  });

  it('busto com chave azul mantém o plano médio e troca só o fundo', () => {
    const prompt = buildTalkPrompt(null, { keyColor: '#0047BB', framing: 'busto' });
    expect(prompt).toContain('Static medium shot');
    expect(prompt).toContain('plain solid blue background');
    expect(prompt).not.toBe(TALK_PROMPT_SUFFIX);
  });
});

describe('buildTalkPrompt — variante contínua (change video-fala-continua, D7)', () => {
  it('troca a pose neutra no início/fim pela tomada contínua e mantém as proibições de texto e logo', () => {
    const prompt = buildTalkPrompt('Waves.', null, { continuous: true });
    expect(prompt).not.toContain('Start and end in a neutral');
    expect(prompt).toContain('speaks several sentences in one continuous take');
    expect(prompt).toContain('never reset or change pose between sentences');
    expect(prompt).toContain('Absolutely no text anywhere in the frame');
    expect(prompt.startsWith('Waves. ')).toBe(true);
  });

  it('sem `continuous` o texto é o de hoje, byte a byte (com e sem recorte)', () => {
    expect(buildTalkPrompt('Waves.', null, {})).toBe(buildTalkPrompt('Waves.'));
    const cutout = { keyColor: '#00B140', framing: 'corpo' as const };
    expect(buildTalkPrompt(null, cutout, { continuous: false })).toBe(
      buildTalkPrompt(null, cutout),
    );
  });

  it('a variante contínua preserva o modo sem fundo (cor-chave e plano de corpo)', () => {
    const prompt = buildTalkPrompt(
      null,
      { keyColor: '#00B140', framing: 'corpo' },
      { continuous: true },
    );
    expect(prompt).toContain('plain solid green background');
    expect(prompt).toContain('whole figure in frame');
    expect(prompt).toContain('one continuous take');
  });
});
