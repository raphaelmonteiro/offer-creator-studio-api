import {
  detectionsToOutputFrame,
  MC_PRICE_DETECT_MOCK_PRICE,
  MC_PRICE_DETECT_PROMPT,
  mockPriceDetections,
  parseMockScenario,
  parsePriceDetectResponse,
} from './mc-price-detect';
import { defaultCharacterWindow, windowCoversPriceWarning } from './mc-talking-art-window';

describe('detecção de preços na arte (tarefa 4.7) — prompt, parser e mock', () => {
  it('prompt pede só preços com box_2d 0–1000 em JSON compacto', () => {
    expect(MC_PRICE_DETECT_PROMPT).toContain('"prices"');
    expect(MC_PRICE_DETECT_PROMPT).toContain('box_2d');
    expect(MC_PRICE_DETECT_PROMPT).toMatch(/0-1000/);
  });

  it('parser: box_2d [ymin,xmin,ymax,xmax] 0–1000 → frações; cerca ```json tolerada; confiança presa a 0..1', () => {
    const text =
      '```json\n{"prices": [{"text": "R$ 9,99", "box_2d": [450, 580, 800, 960], "confidence": 1.4},' +
      ' {"text": "4,49", "box_2d": [0.1, 0.1, 0.2, 0.3]}]}\n```';
    expect(parsePriceDetectResponse(text)).toEqual([
      {
        text: 'R$ 9,99',
        bbox: { x: 0.58, y: 0.45, w: 0.38, h: 0.35 },
        kind: 'price',
        confidence: 1,
      },
      { text: '4,49', bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, kind: 'price', confidence: 0.8 },
    ]);
  });

  it('parser: itens sem caixa válida caem; bbox {x,y,w,h} aceita; sem "prices" ou JSON ilegível → null', () => {
    expect(
      parsePriceDetectResponse(
        '{"prices": [{"text": "x", "box_2d": [1, 2]}, {"text": "5,00", "bbox": {"x": 0.9, "y": 0.9, "w": 0.3, "h": 0.3}}]}',
      ),
    ).toEqual([
      // presa ao quadro
      { text: '5,00', bbox: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, kind: 'price', confidence: 0.8 },
    ]);
    expect(parsePriceDetectResponse('{"prices": []}')).toEqual([]);
    expect(parsePriceDetectResponse('{"found": true}')).toBeNull();
    expect(parsePriceDetectResponse('sem json')).toBeNull();
    expect(parsePriceDetectResponse('{prices: [}')).toBeNull();
  });

  it('mock: none → nada; overlap → preço à direita + título (não-preço); cenário desconhecido → none', () => {
    expect(mockPriceDetections('none')).toEqual([]);
    const overlap = mockPriceDetections('overlap');
    expect(overlap).toHaveLength(2);
    expect(overlap[0]).toEqual(MC_PRICE_DETECT_MOCK_PRICE);
    expect(overlap[0]).not.toBe(MC_PRICE_DETECT_MOCK_PRICE); // cópia
    expect(overlap[1].kind).toBe('text');
    expect(parseMockScenario('OVERLAP')).toBe('overlap');
    expect(parseMockScenario('error')).toBe('error');
    expect(parseMockScenario(undefined)).toBe('none');
    expect(parseMockScenario('talvez')).toBe('none');
  });

  it('caixas da ARTE → quadro de saída por contain-fit (arte 1:1 em 9:16 desce 420 px)', () => {
    const [d] = detectionsToOutputFrame(
      [{ text: 'R$ 1,00', bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, kind: 'price' }],
      { width: 1080, height: 1080 },
      { width: 1080, height: 1920 },
    );
    // y = (420 + 540) / 1920 = 0,5; h = 108 / 1920 = 0,0563
    expect(d.bbox).toEqual({ x: 0.5, y: 0.5, w: 0.2, h: 0.0563 });
    expect(d.text).toBe('R$ 1,00');
  });

  it.each([
    ['9:16 nativo', { width: 1080, height: 1920 }, { width: 1080, height: 1920 }],
    ['1:1 em 9:16', { width: 1080, height: 1080 }, { width: 1080, height: 1920 }],
    ['4:5 nativo', { width: 1080, height: 1350 }, { width: 1080, height: 1350 }],
    ['16:9 nativo', { width: 1920, height: 1080 }, { width: 1920, height: 1080 }],
  ])('o preço do mock overlap cobre a janela default (%s)', (_label, art, out) => {
    const detections = detectionsToOutputFrame(mockPriceDetections('overlap'), art, out);
    const window = defaultCharacterWindow({ ...out, tileWidth: 720, tileHeight: 960 });
    const warning = windowCoversPriceWarning(detections, window);
    expect(warning?.code).toBe('WINDOW_COVERS_PRICE');
    expect(warning?.covered).toHaveLength(1); // o título não é preço
  });
});
