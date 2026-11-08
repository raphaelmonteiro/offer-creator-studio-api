import { layer } from '../testing/scene-template-fixtures';
import { cmToPreviewPixels, mapLayersToSections, sectionOfCenter } from './scene-template-layers';

const input = {
  widthPx: 1920,
  heightPx: 3840,
  artWidthCm: 27.5,
  headerPx: 427,
  footerPx: 284,
  logoUrlOf: (id: string) => (id === 'ok' ? 'http://cdn/logo.png' : undefined),
};

describe('mapeamento das camadas para o cabeçalho e o rodapé (PV-5)', () => {
  it('72 DPI: 27,5 cm viram 780 px', () => {
    expect(cmToPreviewPixels(27.5)).toBe(780);
  });

  it('a seção é a zona do centro da camada; o miolo fica de fora', () => {
    const bands = { headerPx: 427, footerPx: 284 };
    expect(sectionOfCenter(0.05, 3840, bands)).toBe('header');
    expect(sectionOfCenter(0.5, 3840, bands)).toBeNull();
    expect(sectionOfCenter(0.97, 3840, bands)).toBe('footer');
  });

  it('o y do elemento do rodapé é relativo ao topo do rodapé', () => {
    const footerTop = 3840 - 284;
    const y = (footerTop + 142) / 3840; // centro do rodapé
    const result = mapLayersToSections({
      ...input,
      elements: [layer({ id: 't', text: 'x', y, w: 0.5, aspect: 5, fontSize: 5 })],
    });
    const [text] = result.footer;
    expect(text.y + text.height / 2).toBeCloseTo((142 * 780) / 1920, 1);
    expect(result.header).toEqual([]);
  });

  it('rotação e z vão direto; logo sem cópia e texto vazio ficam de fora', () => {
    const result = mapLayersToSections({
      ...input,
      elements: [
        layer({ id: 'a', kind: 'logo', assetId: 'ok', y: 0.03, rotation: 15, z: 7 }),
        layer({ id: 'b', kind: 'logo', assetId: 'sem-copia', y: 0.03 }),
        layer({ id: 'c', text: '', y: 0.03 }),
        layer({ id: 'd', kind: 'sun' as never, y: 0.03 }),
      ],
    });
    expect(result.header).toHaveLength(1);
    expect(result.header[0]).toMatchObject({ id: 'a', rotation: 15, zIndex: 7, type: 'image' });
  });

  it('camada que passa da borda da seção é mantida', () => {
    const result = mapLayersToSections({
      ...input,
      elements: [layer({ id: 'a', kind: 'logo', assetId: 'ok', x: 0.99, y: 0.05, w: 0.3 })],
    });
    expect(result.header[0].x + result.header[0].width).toBeGreaterThan(780);
  });
});
