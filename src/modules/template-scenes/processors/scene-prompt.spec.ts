import { computeSceneZones, findSceneFormat, SCENE_FORMATS } from '../domain/scene-formats';
import { nativeSizeOfFormat } from '../domain/scene-format-size';
import {
  buildEditPrompt,
  buildGeneratePrompt,
  buildGlobalPrompt,
  buildTransparentPrompt,
  REMOVE_INSTRUCTION,
} from './scene-prompt';

const format = findSceneFormat('folheto-27x54')!;
const base = {
  request: 'campo verde com sol à direita',
  artWidthCm: format.artWidthCm,
  artHeightCm: format.artHeightCm,
  widthPx: 1920,
  heightPx: 3840,
  zones: computeSceneZones(format),
};
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

describe('buildGeneratePrompt', () => {
  it('traz o pedido literal, o formato em cm, a proporção e o tamanho em px', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).toContain('"campo verde com sol à direita"');
    expect(prompt).toContain('27,5 x 55 cm');
    expect(prompt).toContain('proporção largura/altura 0,50');
    expect(prompt).toContain('1920 x 3840 px');
  });

  it('descreve as faixas e o miolo em porcentagem da altura (folheto 27x54: 11%, 81%, 7%)', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).toContain('cabeçalho (faixa superior de 11% da altura)');
    expect(prompt).toContain('miolo (81% da altura)');
    expect(prompt).toContain('rodapé (faixa inferior de 7% da altura)');
  });

  it('põe os elementos da cena nas faixas de cabeçalho e rodapé e deixa o miolo calmo, sem objetos', () => {
    const lines = buildGeneratePrompt(base).split('\n');
    const header = lines.find((line) => line.startsWith('- cabeçalho'))!;
    const body = lines.find((line) => line.startsWith('- miolo'))!;
    const footer = lines.find((line) => line.startsWith('- rodapé'))!;
    expect(header).toContain('aqui ficam os elementos da cena');
    expect(footer).toContain('aqui também ficam elementos da cena');
    expect(body).toContain('calmo');
    expect(body).toContain('SEM objetos');
    expect(body).toContain('cards de produtos e preços ficam por cima');
    expect(buildGeneratePrompt(base)).toContain('Nenhum elemento da cena pode invadir o miolo.');
  });

  it('as faixas deixam de ser "área limpa" (a instrução antiga sai)', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).not.toContain('área limpa');
    expect(prompt).not.toContain('para o título e o logo');
    expect(prompt).not.toContain('para o endereço e as informações da loja');
  });

  it('traz as regras fixas', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).toContain('sem texto legível');
    expect(prompt).toContain('sem logotipos');
    expect(prompt).toContain('sem preços');
  });

  it('mantém o pedido literal, com marcadores, e limpa controle e espaços', () => {
    const prompt = buildGeneratePrompt({ ...base, request: '  campo\n\n  verde \t #falha-quota ' });
    expect(prompt).toContain('"campo verde #falha-quota"');
  });

  describe.each(Object.keys(SCENE_FORMATS))('formato %s', (formatId) => {
    const spec = findSceneFormat(formatId)!;
    const zones = computeSceneZones(spec);
    const size = nativeSizeOfFormat(spec)!;
    const prompt = buildGeneratePrompt({
      request: 'pascoa 2k27',
      artWidthCm: spec.artWidthCm,
      artHeightCm: spec.artHeightCm,
      widthPx: size.width,
      heightPx: size.height,
      zones,
    });

    it('usa as porcentagens das zonas daquele formato', () => {
      expect(prompt).toContain(`cabeçalho (faixa superior de ${pct(zones.header.h)} da altura)`);
      expect(prompt).toContain(`miolo (${pct(zones.body.h)} da altura)`);
      expect(prompt).toContain(`rodapé (faixa inferior de ${pct(zones.footer.h)} da altura)`);
    });

    it('pede o miolo sem objetos e mantém as regras fixas', () => {
      expect(prompt).toContain('SEM objetos');
      expect(prompt).toContain('sem texto legível');
      expect(prompt).toContain('sem logotipos');
      expect(prompt).toContain('sem preços');
    });
  });
});

describe('buildEditPrompt', () => {
  it('começa com "Na área marcada" e traz a instrução literal e a preservação do resto', () => {
    const prompt = buildEditPrompt({
      request: 'deixa o sol  mais\nalaranjado',
      remove: false,
      knownElements: [],
    });
    expect(prompt.startsWith('Na área marcada: deixa o sol mais alaranjado.')).toBe(true);
    expect(prompt).toContain('Altere somente a área indicada pela máscara');
    expect(prompt).toContain('Preserve todo o resto da imagem');
  });

  it('cita o nome dos elementos conhecidos na região', () => {
    const prompt = buildEditPrompt({
      request: 'mais brilho',
      remove: false,
      knownElements: ['Sol', 'Nuvem'],
    });
    expect(prompt.startsWith('Na área marcada (Sol, Nuvem): mais brilho.')).toBe(true);
  });

  it('remover troca a instrução pela remoção com continuação do fundo', () => {
    const prompt = buildEditPrompt({ request: 'remover o sol', remove: true, knownElements: [] });
    expect(prompt).toContain(REMOVE_INSTRUCTION);
    expect(prompt).not.toContain('remover o sol');
  });
});

describe('buildGlobalPrompt e buildTransparentPrompt', () => {
  it('o ajuste geral mantém a composição e as zonas', () => {
    const prompt = buildGlobalPrompt({ request: 'deixa tudo mais quente', zones: base.zones });
    expect(prompt).toContain('"deixa tudo mais quente"');
    expect(prompt).toContain('Mantenha a composição');
    expect(prompt).toContain('cabeçalho de 11%, miolo de 81%');
    expect(prompt).toContain('sem texto legível');
  });

  it('o "adicionar" pede o item isolado com fundo transparente', () => {
    const prompt = buildTransparentPrompt('balão de ar quente');
    expect(prompt).toContain('balão de ar quente');
    expect(prompt).toContain('fundo totalmente transparente');
    expect(prompt).toContain('sem logotipos');
  });
});
