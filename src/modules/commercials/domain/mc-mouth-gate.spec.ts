import {
  MC_MOUTH_GATE_MIN_CONFIDENCE,
  MC_MOUTH_GATE_PROMPT,
  McMouthVerdict,
  decideMouthGate,
  parseMouthVerdict,
  parseNormalizedBox,
} from './mc-mouth-gate';

const base: McMouthVerdict = {
  hasMouth: true,
  mouthOpenPossible: true,
  confidence: 0.9,
  bbox: { x: 0.3, y: 0.2, w: 0.4, h: 0.4 },
  model: 'test',
  at: '2026-10-12T00:00:00.000Z',
};

describe('mc-mouth-gate — decisão do gate de boca (spec video-character-kit)', () => {
  it('boca com abertura e confiança alta → passed', () => {
    expect(decideMouthGate(base)).toBe('passed');
  });

  it('boca de traço único (sem abertura) com confiança → blocked (MOUTH_NOT_LEGIBLE)', () => {
    expect(decideMouthGate({ ...base, mouthOpenPossible: false })).toBe('blocked');
    expect(decideMouthGate({ ...base, hasMouth: false, mouthOpenPossible: false })).toBe('blocked');
  });

  it('resultado incerto (confiança < 0,7) → undecided, mesmo que diga que há boca', () => {
    expect(decideMouthGate({ ...base, confidence: 0.5 })).toBe('undecided');
    expect(decideMouthGate({ ...base, mouthOpenPossible: false, confidence: 0.69 })).toBe(
      'undecided',
    );
    expect(decideMouthGate({ ...base, confidence: MC_MOUTH_GATE_MIN_CONFIDENCE })).toBe('passed');
  });

  it('sem veredito (visão não rodou) → undecided', () => {
    expect(decideMouthGate(null)).toBe('undecided');
    expect(decideMouthGate(undefined)).toBe('undecided');
    expect(decideMouthGate({ ...base, confidence: Number.NaN })).toBe('undecided');
  });
});

describe('mc-mouth-gate — parse da resposta do modelo', () => {
  it('lê o JSON com as chaves do contrato (snake_case) e devolve camelCase com a caixa', () => {
    const parsed = parseMouthVerdict(
      '```json\n{"has_mouth": true, "mouth_open_possible": true, "confidence": 0.82, ' +
        '"bbox": {"x": 0.25, "y": 0.1, "w": 0.5, "h": 0.45}}\n```',
    );
    expect(parsed).toEqual({
      hasMouth: true,
      mouthOpenPossible: true,
      confidence: 0.82,
      bbox: { x: 0.25, y: 0.1, w: 0.5, h: 0.45 },
    });
  });

  it('sem has_mouth booleano (ou sem JSON) → null; caixa inválida vira null sem derrubar o veredito', () => {
    expect(parseMouthVerdict('não sei dizer')).toBeNull();
    expect(parseMouthVerdict('{"confidence": 0.9}')).toBeNull();
    expect(
      parseMouthVerdict(
        '{"has_mouth": true, "mouth_open_possible": true, "confidence": 0.9, "bbox": "none"}',
      ),
    ).toEqual({
      hasMouth: true,
      mouthOpenPossible: true,
      confidence: 0.9,
      bbox: null,
    });
  });

  it('mouth_open_possible sem boca é false; confiança fora de 0..1 é clampada', () => {
    expect(
      parseMouthVerdict('{"has_mouth": false, "mouth_open_possible": true, "confidence": 7}'),
    ).toEqual({
      hasMouth: false,
      mouthOpenPossible: false,
      confidence: 1,
      bbox: null,
    });
  });

  it('parseNormalizedBox: números em 0..1 com área positiva, recortados à imagem', () => {
    expect(parseNormalizedBox({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 })).toEqual({
      x: 0.8,
      y: 0.9,
      w: 0.2,
      h: 0.1,
    });
    expect(parseNormalizedBox({ x: 0.1, y: 0.1, w: 0, h: 0.2 })).toBeNull();
    expect(parseNormalizedBox({ x: '0.1', y: '0.1', w: '0.3', h: '0.3' })).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.3,
      h: 0.3,
    });
    expect(parseNormalizedBox(null)).toBeNull();
  });

  it('o prompt pede JSON compacto com as quatro chaves do contrato', () => {
    for (const key of ['has_mouth', 'mouth_open_possible', 'confidence', 'bbox']) {
      expect(MC_MOUTH_GATE_PROMPT).toContain(key);
    }
  });
});
