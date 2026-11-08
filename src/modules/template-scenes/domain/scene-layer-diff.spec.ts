import { describeLayerDiff, noLayerChangeText } from './scene-layer-diff';
import { SceneElement, SceneZones } from './scene.types';

const ZONES: SceneZones = {
  header: { x: 0, y: 0, w: 1, h: 0.22 },
  body: { x: 0, y: 0.22, w: 1, h: 0.63 },
  footer: { x: 0, y: 0.85, w: 1, h: 0.15 },
};
const text = (over: Partial<SceneElement> = {}): SceneElement => ({
  id: 't1',
  kind: 'text',
  name: 'Texto 1',
  x: 0.5,
  y: 0.92,
  w: 0.6,
  aspect: 5,
  rotation: 0,
  z: 1,
  text: 'Promoção de Páscoa',
  ...over,
});

describe('Resposta de camada pela diferença (D-51)', () => {
  it('Camada que mudou: do centro para o rodapé, à direita', () => {
    const diff = describeLayerDiff([text()], [text({ x: 0.66 })], ZONES);
    expect(diff).toEqual({
      changed: true,
      text: 'Movi a camada “Texto 1” para o rodapé, à direita.',
    });
  });

  it('Camada que não mudou: sem diferença, sem texto, e a frase de "já está"', () => {
    expect(describeLayerDiff([text({ x: 0.66 })], [text({ x: 0.66 })], ZONES)).toEqual({
      changed: false,
      text: null,
    });
    expect(noLayerChangeText(text({ x: 0.66 }), ZONES)).toBe(
      'A camada “Texto 1” já está no rodapé, à direita; nada mudou. Diga onde quer, ou arraste no quadro.',
    );
    expect(noLayerChangeText(null, ZONES)).toBe(
      'Nenhuma camada mudou. Diga onde quer, ou arraste no quadro.',
    );
  });

  it('camada nova, texto trocado, tamanho e camada tirada têm cada uma a sua frase', () => {
    expect(describeLayerDiff([], [text()], ZONES).text).toBe(
      'Coloquei a frase “Promoção de Páscoa” como camada de texto no rodapé, no centro. Dá para arrastar e mudar fonte e cor no quadro.',
    );
    expect(describeLayerDiff([text()], [text({ text: 'Oferta' })], ZONES).text).toBe(
      'Troquei o texto da camada para “Oferta”.',
    );
    expect(describeLayerDiff([text()], [text({ fontSize: 9 })], ZONES).text).toBe(
      'Mudei o tamanho da camada “Texto 1”.',
    );
    expect(describeLayerDiff([text()], [], ZONES).text).toBe('Tirei a camada “Texto 1”.');
  });
});
