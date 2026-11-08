import { SCENE_FORMAT_IDS, findSceneFormat } from '../domain/scene-formats';
import { nativeSizeOfFormat } from '../domain/scene-format-size';
import { directorImage } from '../testing/scene-director-fixtures';
import {
  buildEditPrompt,
  buildGeneratePrompt,
  CONTINUITY_PHRASE,
  CONTINUITY_PHRASE_EN,
  CONTINUOUS_IMAGE_RULE,
  FIXED_RULES,
} from './scene-prompt';

const TALL = 'folheto-27x54';
const IMAGE = directorImage({ change: 'Reorganizar os ovos', preserve: ['coelho'] });
const edit = (formatId: string, composition: boolean, clientMessages: string[] = []) =>
  buildEditPrompt({
    image: IMAGE,
    composition,
    marked: false,
    formatId,
    clientMessages,
    widthPx: 1920,
    heightPx: 3840,
  });

const generate = (formatId: string, clientMessages: string[] = ['quero um template de pascoa']) => {
  const format = findSceneFormat(formatId)!;
  const native = nativeSizeOfFormat(format)!;
  return buildGeneratePrompt({
    request: 'Criar a composição do template de Páscoa.',
    artWidthCm: format.artWidthCm,
    artHeightCm: format.artHeightCm,
    widthPx: native.width,
    heightPx: native.height,
    formatId,
    clientMessages,
  });
};

describe('Frase de continuidade no formato alto (D-43)', () => {
  it('Primeira imagem no formato alto: a frase vem logo depois da regra de imagem contínua', () => {
    const lines = generate(TALL).split('\n');
    const rule = lines.indexOf(CONTINUOUS_IMAGE_RULE);
    expect(rule).toBeGreaterThan(-1);
    expect(lines[rule + 1]).toBe(CONTINUITY_PHRASE);
    expect(lines[rule + 2]).toBe(FIXED_RULES);
  });

  it('o texto da frase é o literal do dono', () => {
    expect(CONTINUITY_PHRASE).toBe(
      'A cena é um único ambiente contínuo do topo à base: um só horizonte, um só chão, e nenhum objeto ou grupo apoiado em ilha, faixa ou pedaço de terreno separado.',
    );
  });

  it('Composição e imagem nova no formato alto: o prompt traz a frase', () => {
    expect(edit(TALL, true)).toContain(CONTINUITY_PHRASE_EN);
    expect(generate(TALL)).toContain(CONTINUITY_PHRASE);
  });

  it('Ajuste, item e marcação no formato alto: o prompt não traz a frase', () => {
    expect(edit(TALL, false)).not.toContain(CONTINUITY_PHRASE_EN);
  });

  it.each(SCENE_FORMAT_IDS.filter((id) => id !== TALL))(
    'Outros formatos: %s não traz a frase, na primeira imagem nem na composição',
    (formatId) => {
      expect(generate(formatId)).not.toContain(CONTINUITY_PHRASE);
      expect(edit(formatId, true)).not.toContain(CONTINUITY_PHRASE_EN);
    },
  );

  it('o formato alto é o único que leva a frase em toda a lista de formatos', () => {
    expect(SCENE_FORMAT_IDS.filter((id) => generate(id).includes(CONTINUITY_PHRASE))).toEqual([
      TALL,
    ]);
  });

  it.each([
    'divide em duas partes, azul em cima e verde embaixo',
    'coloca uma moldura dourada',
    'quero uma faixa de flores',
    'faz um banner no meio',
  ])('Cliente pede divisão no formato alto: "%s" tira a frase, e o pedido segue', (message) => {
    const prompt = generate(TALL, ['quero um template', message]);
    expect(prompt).not.toContain(CONTINUITY_PHRASE);
    expect(prompt).toContain('Pedido do cliente:');
  });

  it('cabeçalho e rodapé não tiram a frase: arranjo não é divisão', () => {
    expect(generate(TALL, ['coloca ovos no rodapé e o coelho no cabeçalho'])).toContain(
      CONTINUITY_PHRASE,
    );
  });

  it('sem formato, nada muda (chamadores antigos e o literal do anexo)', () => {
    expect(edit('inexistente', true)).not.toContain(CONTINUITY_PHRASE_EN);
    expect(
      buildGeneratePrompt({
        request: 'x',
        artWidthCm: 28,
        artHeightCm: 35,
        widthPx: 1152,
        heightPx: 1440,
      }),
    ).not.toContain(CONTINUITY_PHRASE);
  });
});
