import { computeSceneZones, findSceneFormat } from '../domain/scene-formats';
import { buildGeneratePrompt } from './scene-prompt';

const format = findSceneFormat('folheto-27x54')!;
const base = {
  request: 'campo verde com sol à direita',
  artWidthCm: format.artWidthCm,
  artHeightCm: format.artHeightCm,
  widthPx: 1920,
  heightPx: 3840,
  zones: computeSceneZones(format),
};

describe('buildGeneratePrompt', () => {
  it('traz o pedido literal, o formato em cm, a proporção e o tamanho em px', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).toContain('"campo verde com sol à direita"');
    expect(prompt).toContain('27,5 x 55 cm');
    expect(prompt).toContain('proporção largura/altura 0,50');
    expect(prompt).toContain('1920 x 3840 px');
  });

  it('descreve as zonas reservadas em porcentagem da altura', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).toContain('cabeçalho (faixa superior de 11% da altura)');
    expect(prompt).toContain('miolo (81% da altura)');
    expect(prompt).toContain('rodapé (faixa inferior de 7% da altura)');
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
});
