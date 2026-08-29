import {
  alignmentToWords,
  buildCaptionCues,
  CAPTION_MAX_CHARS,
  ElevenLabsAlignment,
  syntheticAlignment,
} from './mc-captions';

/** Alinhamento por caractere no formato da ElevenLabs, 1 caractere = `step` segundos. */
function alignmentOf(text: string, step = 0.1): ElevenLabsAlignment {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => Number((i * step).toFixed(4))),
    character_end_times_seconds: characters.map((_, i) => Number(((i + 1) * step).toFixed(4))),
  };
}

describe('mc-captions — legendas a partir dos timestamps do TTS (plano §5.4)', () => {
  it('alignmentToWords agrupa caracteres em palavras com janela de tempo', () => {
    const words = alignmentToWords(alignmentOf('oi voce'));
    expect(words.map((w) => w.text)).toEqual(['oi', 'voce']);
    expect(words[0].startS).toBeCloseTo(0);
    expect(words[0].endS).toBeCloseTo(0.2);
    expect(words[1].startS).toBeCloseTo(0.3); // o espaço não entra na palavra
  });

  it('quebra as linhas em ~38 caracteres sem cortar palavra', () => {
    const texto = 'aproveite hoje o arroz integral fresquinho do nosso mercado favorito da cidade';
    const cues = buildCaptionCues(alignmentOf(texto));
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
      expect(cue.text).not.toMatch(/^\s|\s$/);
    }
    // nenhuma palavra se perde nem se parte
    expect(cues.map((c) => c.text).join(' ')).toBe(texto);
  });

  it('fecha a linha na pontuação forte (fim de frase)', () => {
    const cues = buildCaptionCues(alignmentOf('Chegou! Corre pro mercado'));
    expect(cues[0].text).toBe('Chegou!');
    expect(cues[1].text).toBe('Corre pro mercado');
  });

  it('vírgula só quebra a linha quando ela já está cheia', () => {
    const curta = buildCaptionCues(alignmentOf('oi, tudo bem'));
    expect(curta).toHaveLength(1);
    const cheia = buildCaptionCues(
      alignmentOf('aproveite o arroz integral hoje, corre pro mercado'),
    );
    expect(cheia.length).toBeGreaterThan(1);
    expect(cheia[0].text.endsWith(',')).toBe(true);
  });

  it('as cues são monotônicas e respeitam a janela do TTS', () => {
    const cues = buildCaptionCues(alignmentOf('primeira frase aqui. segunda frase ali'));
    for (const cue of cues) expect(cue.endS).toBeGreaterThan(cue.startS);
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i].startS).toBeGreaterThanOrEqual(cues[i - 1].startS);
    }
  });

  it('offsetS desloca a cena para a posição dela no vídeo final', () => {
    const semOffset = buildCaptionCues(alignmentOf('bem vindo'));
    const comOffset = buildCaptionCues(alignmentOf('bem vindo'), { offsetS: 12 });
    expect(comOffset[0].startS).toBeCloseTo(semOffset[0].startS + 12);
    expect(comOffset[0].endS).toBeCloseTo(semOffset[0].endS + 12);
  });

  it('clipDurationS impede a legenda de passar do fim do clipe', () => {
    const cues = buildCaptionCues(alignmentOf('oi'), { clipDurationS: 0.15, offsetS: 2 });
    expect(cues[0].endS).toBeCloseTo(2.15);
  });

  it('alinhamento ausente/inconsistente → sem legenda (degradação silenciosa)', () => {
    expect(buildCaptionCues(null)).toEqual([]);
    expect(buildCaptionCues(undefined)).toEqual([]);
    expect(
      buildCaptionCues({
        characters: ['a', 'b'],
        character_start_times_seconds: [0],
        character_end_times_seconds: [0.1],
      }),
    ).toEqual([]);
  });

  it('syntheticAlignment (mock) distribui os caracteres uniformemente na duração', () => {
    const alignment = syntheticAlignment('abcd', 2);
    expect(alignment.characters).toEqual(['a', 'b', 'c', 'd']);
    expect(alignment.character_start_times_seconds[0]).toBe(0);
    expect(alignment.character_end_times_seconds[3]).toBeCloseTo(2);
    // e alimenta o pipeline de legendas normalmente
    expect(buildCaptionCues(alignment)[0].text).toBe('abcd');
  });
});
