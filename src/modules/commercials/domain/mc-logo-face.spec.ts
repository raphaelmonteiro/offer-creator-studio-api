import { HttpException } from '@nestjs/common';
import {
  assertLogoFaceReady,
  clampLogoBox,
  confirmLogoBox,
  logoBoxActions,
  logoBoxIoU,
  logoFaceReadiness,
  MC_LOGO_BOX_MIN_CONFIDENCE,
  McLogoLocatorResult,
  McProjectLogoBox,
  parseLogoLocatorResponse,
  readProjectLogoBox,
  resolveLogoBox,
  resolveTalkWindowColor,
  sampleLogoBoxSurroundColor,
  validateLogoBoxInArt,
} from './mc-logo-face';

const BOX = { x: 0.05, y: 0.86, w: 0.22, h: 0.09 };

const detection = (over: Partial<McLogoLocatorResult> = {}): McLogoLocatorResult => ({
  found: true,
  bbox: { ...BOX },
  confidence: 0.92,
  model: 'gemini-3.8-flash',
  at: '2026-10-12T10:00:00.000Z',
  ...over,
});

const stored = (over: Partial<McProjectLogoBox> = {}): McProjectLogoBox => ({
  ...BOX,
  logoBoxSource: 'detected',
  logoBoxConfidence: 0.92,
  logoBoxConfirmed: false,
  ...over,
});

describe('mc-logo-face — caixa do logo em camadas (D9b, tarefa 4.6)', () => {
  describe('resolveLogoBox', () => {
    it('(a) caixa do layout é usada como está, confirmada, sem olhar a detecção', () => {
      const result = resolveLogoBox({
        layoutBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
        detection: detection({ bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }),
      });
      expect(result).toEqual({
        source: 'layout',
        logoBox: {
          x: 0.1,
          y: 0.8,
          w: 0.2,
          h: 0.1,
          logoBoxSource: 'layout',
          logoBoxConfidence: null,
          logoBoxConfirmed: true,
        },
        confidence: null,
        confirmed: true,
        actions: [],
      });
    });

    it('(b/c) detecção com confiança ≥ 0,7 é PROPOSTA ao usuário (não confirmada)', () => {
      const result = resolveLogoBox({ detection: detection() });
      expect(result).toMatchObject({
        source: 'detected',
        confirmed: false,
        confidence: 0.92,
        actions: ['confirm_logo_box', 'mark_logo_box'],
        logoBox: { ...BOX, logoBoxSource: 'detected', logoBoxConfirmed: false },
      });
      // o limite é inclusivo
      expect(
        resolveLogoBox({ detection: detection({ confidence: MC_LOGO_BOX_MIN_CONFIDENCE }) }).source,
      ).toBe('detected');
    });

    it('(c) abaixo de 0,7 pede a marcação: `none`, nada a gravar', () => {
      const result = resolveLogoBox({ detection: detection({ confidence: 0.69 }) });
      expect(result).toEqual({
        source: 'none',
        logoBox: null,
        confidence: 0.69,
        confirmed: false,
        actions: ['mark_logo_box', 'use_window'],
      });
    });

    it('não achou, achou sem caixa, ou visão fora do ar → `none` (mesmo com caixa e confiança altas)', () => {
      expect(resolveLogoBox({ detection: detection({ found: false }) }).source).toBe('none');
      expect(resolveLogoBox({ detection: detection({ bbox: null }) }).source).toBe('none');
      expect(
        resolveLogoBox({ detection: detection({ error: 'HTTP 503', confidence: 0.95 }) }),
      ).toMatchObject({ source: 'none', logoBox: null });
      expect(resolveLogoBox({}).source).toBe('none');
    });

    it('caixa do modelo fora da arte é recortada a [0,1]²; caixa sem área é descartada', () => {
      const result = resolveLogoBox({
        detection: detection({ bbox: { x: 0.9, y: 0.95, w: 0.2, h: 0.1 } }),
      });
      expect(result.logoBox).toMatchObject({ x: 0.9, y: 0.95, w: 0.1, h: 0.05 });
      expect(clampLogoBox({ x: 1.2, y: 0.1, w: 0.2, h: 0.1 })).toBeNull();
      expect(clampLogoBox({ x: 0.1, y: 0.1, w: 0, h: 0.1 })).toBeNull();
      expect(clampLogoBox({ x: '0.1', y: 0.1, w: 0.2, h: 0.1 })).toEqual({
        x: 0.1,
        y: 0.1,
        w: 0.2,
        h: 0.1,
      });
    });
  });

  describe('readProjectLogoBox', () => {
    it('caixa antiga sem origem (ponte antes da 4.6) = layout confirmada', () => {
      expect(readProjectLogoBox({ x: 0.1, y: 0.8, w: 0.2, h: 0.1 })).toEqual({
        x: 0.1,
        y: 0.8,
        w: 0.2,
        h: 0.1,
        logoBoxSource: 'layout',
        logoBoxConfidence: null,
        logoBoxConfirmed: true,
      });
    });

    it('proposta detectada sem flag continua não confirmada; coordenadas inválidas → null', () => {
      const { logoBoxConfirmed: _drop, ...noFlag } = stored();
      expect(readProjectLogoBox(noFlag)?.logoBoxConfirmed).toBe(false);
      expect(readProjectLogoBox(stored({ logoBoxConfirmed: true }))?.logoBoxConfirmed).toBe(true);
      expect(readProjectLogoBox({ logoBoxSource: 'detected', logoBoxConfidence: 0.4 })).toBeNull();
      expect(readProjectLogoBox(null)).toBeNull();
    });

    it('ações da UI: pronta → nenhuma; proposta → confirmar/marcar; sem caixa → marcar/janela comum', () => {
      expect(logoBoxActions(stored({ logoBoxConfirmed: true }))).toEqual([]);
      expect(logoBoxActions(stored())).toEqual(['confirm_logo_box', 'mark_logo_box']);
      expect(logoBoxActions(null)).toEqual(['mark_logo_box', 'use_window']);
    });
  });

  describe('validateLogoBoxInArt (PUT)', () => {
    it('caixa inteira dentro da arte passa — inclusive encostada na borda', () => {
      expect(validateLogoBoxInArt({ x: 0.05, y: 0.86, w: 0.22, h: 0.09 })).toBeNull();
      expect(validateLogoBoxInArt({ x: 0.8, y: 0.9, w: 0.2, h: 0.1 })).toBeNull();
    });

    it('frações fora de 0..1 ou não numéricas → LOGO_BOX_INVALID', () => {
      expect(validateLogoBoxInArt({ x: -0.1, y: 0.1, w: 0.2, h: 0.1 })?.code).toBe(
        'LOGO_BOX_INVALID',
      );
      expect(validateLogoBoxInArt({ x: 0.1, y: 1.5, w: 0.2, h: 0.1 })?.code).toBe(
        'LOGO_BOX_INVALID',
      );
      expect(validateLogoBoxInArt({ x: 0.1, y: 0.1, w: NaN, h: 0.1 })?.code).toBe(
        'LOGO_BOX_INVALID',
      );
    });

    it('caixa que sai da arte → LOGO_BOX_OUT_OF_BOUNDS com a borda excedida', () => {
      expect(validateLogoBoxInArt({ x: 0.9, y: 0.5, w: 0.2, h: 0.1 })).toEqual({
        code: 'LOGO_BOX_OUT_OF_BOUNDS',
        message: 'A caixa do logo precisa ficar inteira dentro da arte.',
        details: { logoBox: { x: 0.9, y: 0.5, w: 0.2, h: 0.1 }, right: 1.1, bottom: 0.6 },
      });
      expect(validateLogoBoxInArt({ x: 0.1, y: 0.95, w: 0.2, h: 0.1 })?.code).toBe(
        'LOGO_BOX_OUT_OF_BOUNDS',
      );
    });

    it('caixa menor que 2% da arte em algum lado → LOGO_BOX_TOO_SMALL', () => {
      expect(validateLogoBoxInArt({ x: 0.1, y: 0.1, w: 0.01, h: 0.1 })?.code).toBe(
        'LOGO_BOX_TOO_SMALL',
      );
    });
  });

  describe('confirmLogoBox', () => {
    it('repetir a proposta CONFIRMA a detecção (origem e confiança preservadas)', () => {
      expect(confirmLogoBox(stored(), { x: 0.052, y: 0.86, w: 0.22, h: 0.09 })).toEqual(
        stored({ logoBoxConfirmed: true }),
      );
    });

    it('outra caixa (ou nenhuma anterior) é marcação do usuário', () => {
      const marked = { x: 0.3, y: 0.02, w: 0.25, h: 0.08 };
      const expected = {
        ...marked,
        logoBoxSource: 'user',
        logoBoxConfidence: null,
        logoBoxConfirmed: true,
      };
      expect(confirmLogoBox(stored(), marked)).toEqual(expected);
      expect(confirmLogoBox(null, marked)).toEqual(expected);
    });
  });

  describe('logoBoxIoU', () => {
    it('1 para caixas iguais, 0 para disjuntas, razão exata para sobreposição parcial', () => {
      expect(logoBoxIoU(BOX, BOX)).toBeCloseTo(1, 10);
      expect(logoBoxIoU(BOX, { x: 0.5, y: 0.1, w: 0.2, h: 0.1 })).toBe(0);
      // metade da largura em comum: inter = 0.1·0.2 = 0.02; união = 0.04 + 0.04 − 0.02
      expect(
        logoBoxIoU({ x: 0, y: 0, w: 0.2, h: 0.2 }, { x: 0.1, y: 0, w: 0.2, h: 0.2 }),
      ).toBeCloseTo(1 / 3, 10);
    });
  });

  describe('parseLogoLocatorResponse', () => {
    it('`box_2d` [ymin, xmin, ymax, xmax] em 0–1000 vira frações x/y/w/h (mesmo cercado por ```json)', () => {
      const text =
        '```json\n{"found": true, "confidence": 0.88, "box_2d": [860, 50, 950, 270]}\n```';
      const parsed = parseLogoLocatorResponse(text);
      expect(parsed?.found).toBe(true);
      expect(parsed?.confidence).toBe(0.88);
      expect(parsed?.bbox?.x).toBeCloseTo(0.05, 4);
      expect(parsed?.bbox?.y).toBeCloseTo(0.86, 4);
      expect(parsed?.bbox?.w).toBeCloseTo(0.22, 4);
      expect(parsed?.bbox?.h).toBeCloseTo(0.09, 4);
    });

    it('aceita `bbox` em frações e `box_2d` já normalizado em 0..1', () => {
      expect(
        parseLogoLocatorResponse(
          '{"found": true, "confidence": 0.8, "bbox": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1}}',
        )?.bbox,
      ).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
      expect(
        parseLogoLocatorResponse(
          '{"found": true, "confidence": 0.8, "box_2d": [0.2, 0.1, 0.3, 0.4]}',
        )?.bbox,
      ).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
    });

    it('não achou → confiança 0; achou sem caixa utilizável → found false; lixo → null', () => {
      expect(
        parseLogoLocatorResponse('{"found": false, "confidence": 0.9, "box_2d": null}'),
      ).toEqual({
        found: false,
        bbox: null,
        confidence: 0,
      });
      expect(
        parseLogoLocatorResponse('{"found": true, "confidence": 0.9, "box_2d": [10, 10, 10, 10]}')
          ?.found,
      ).toBe(false);
      expect(parseLogoLocatorResponse('não sei')).toBeNull();
      expect(parseLogoLocatorResponse('{"confidence": 0.9}')).toBeNull();
      expect(parseLogoLocatorResponse('{found: true')).toBeNull();
    });
  });

  describe('logoFaceReadiness / assertLogoFaceReady (aprovação da produção)', () => {
    const f1 = { logoFace: true };

    it('sem modo rosto do logo não há exigência', () => {
      expect(logoFaceReadiness({ logoBox: null }, { logoFace: false })).toBeNull();
      expect(logoFaceReadiness({ logoBox: null }, {})).toBeNull();
      expect(logoFaceReadiness({ logoBox: null }, null)).toBeNull();
    });

    it('logoFace sem caixa → LOGO_BOX_REQUIRED com as ações detectar/marcar', () => {
      expect(logoFaceReadiness({ logoBox: null }, f1)).toEqual({
        code: 'LOGO_BOX_REQUIRED',
        message:
          'O modo rosto do logo precisa da caixa do logo na arte: detecte ou marque a caixa na prévia.',
        details: { actions: ['detect_logo_box', 'mark_logo_box'], source: 'none', logoBox: null },
      });
    });

    it('logoFace com proposta NÃO confirmada → LOGO_BOX_REQUIRED (traz a proposta)', () => {
      const issue = logoFaceReadiness({ logoBox: stored() }, f1);
      expect(issue).toMatchObject({
        code: 'LOGO_BOX_REQUIRED',
        details: {
          actions: ['detect_logo_box', 'mark_logo_box'],
          source: 'detected',
          logoBox: stored(),
        },
      });
    });

    it('caixa confirmada (detecção confirmada, usuário ou layout — inclusive a antiga sem origem) libera', () => {
      expect(logoFaceReadiness({ logoBox: stored({ logoBoxConfirmed: true }) }, f1)).toBeNull();
      expect(
        logoFaceReadiness(
          {
            logoBox: stored({
              logoBoxSource: 'user',
              logoBoxConfidence: null,
              logoBoxConfirmed: true,
            }),
          },
          f1,
        ),
      ).toBeNull();
      expect(logoFaceReadiness({ logoBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 } }, f1)).toBeNull();
    });

    it('assertLogoFaceReady lança 422 no formato dos bloqueios da aprovação', () => {
      expect(() =>
        assertLogoFaceReady({ logoBox: stored({ logoBoxConfirmed: true }) }, f1),
      ).not.toThrow();
      let thrown: unknown;
      try {
        assertLogoFaceReady({ logoBox: stored() }, f1);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HttpException);
      const http = thrown as HttpException;
      expect(http.getStatus()).toBe(422);
      expect(http.getResponse()).toMatchObject({
        code: 'LOGO_BOX_REQUIRED',
        details: { actions: ['detect_logo_box', 'mark_logo_box'] },
        issues: [{ code: 'LOGO_BOX_REQUIRED', sceneId: null }],
      });
    });
  });
});

describe('mc-logo-face — cor da janela no rosto do logo (spec video-talking-art)', () => {
  /** Imagem crua W×H preenchida com `fill`, com retângulos pintados por cima. */
  function image(
    W: number,
    H: number,
    fill: number[],
    rects: Array<{ x: number; y: number; w: number; h: number; rgba: number[] }> = [],
    channels = 4,
  ) {
    const data = new Uint8Array(W * H * channels);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const rect = [...rects]
          .reverse()
          .find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
        const px = rect ? rect.rgba : fill;
        for (let c = 0; c < channels; c += 1) data[(y * W + x) * channels + c] = px[c] ?? 255;
      }
    }
    return { data, width: W, height: H, channels };
  }
  const RED = [0xc6, 0x28, 0x28, 255];
  const WHITE = [255, 255, 255, 255];

  describe('sampleLogoBoxSurroundColor', () => {
    it('mediana do anel POR FORA da caixa: a placa branca de dentro não conta', () => {
      const img = image(200, 100, RED, [{ x: 20, y: 10, w: 60, h: 60, rgba: WHITE }]);
      expect(sampleLogoBoxSurroundColor(img, { x: 0.1, y: 0.1, w: 0.3, h: 0.6 })).toBe('#C62828');
    });

    it('robusta a texto encostado: um traço escuro no anel não muda a mediana', () => {
      const img = image(200, 100, RED, [
        { x: 20, y: 10, w: 60, h: 60, rgba: WHITE },
        { x: 82, y: 10, w: 1, h: 60, rgba: [0, 0, 0, 255] },
      ]);
      expect(sampleLogoBoxSurroundColor(img, { x: 0.1, y: 0.1, w: 0.3, h: 0.6 }, 4)).toBe(
        '#C62828',
      );
    });

    it('caixa na borda da arte: anel recortado à arte; RGB sem alfa também serve', () => {
      const img = image(100, 100, [10, 20, 30], [{ x: 0, y: 0, w: 40, h: 40, rgba: WHITE }], 3);
      expect(sampleLogoBoxSurroundColor(img, { x: 0, y: 0, w: 0.4, h: 0.4 })).toBe('#0A141E');
    });

    it('pixels transparentes ficam de fora; sem anel opaco ou caixa = arte inteira → null', () => {
      const img = image(
        100,
        100,
        [0, 0, 0, 0],
        [
          { x: 30, y: 30, w: 40, h: 40, rgba: WHITE },
          { x: 70, y: 30, w: 3, h: 40, rgba: [0x1e, 0x50, 0xc8, 255] },
        ],
      );
      expect(sampleLogoBoxSurroundColor(img, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 })).toBe('#1E50C8');
      expect(
        sampleLogoBoxSurroundColor(image(50, 50, [0, 0, 0, 0]), { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }),
      ).toBeNull();
      expect(sampleLogoBoxSurroundColor(image(50, 50, RED), { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
      expect(sampleLogoBoxSurroundColor(image(50, 50, RED), { x: 0, y: 0, w: 0, h: 1 })).toBeNull();
    });

    it('espessura do anel: 0,6% do lado maior, mínimo 3 px', () => {
      // a 4 px da caixa há uma faixa azul: o anel de 3 px (arte 100×100) não a alcança
      const img = image(100, 100, RED, [
        { x: 40, y: 40, w: 20, h: 20, rgba: WHITE },
        { x: 0, y: 0, w: 100, h: 36, rgba: [0, 0, 255, 255] },
      ]);
      expect(sampleLogoBoxSurroundColor(img, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe('#C62828');
    });
  });

  describe('resolveTalkWindowColor', () => {
    const box = {
      ...BOX,
      logoBoxSource: 'layout',
      logoBoxConfidence: null,
      logoBoxConfirmed: true,
    };

    it('roteiro → cor amostrada (só no rosto do logo) → fundo do kit → fallback, sempre maiúscula', () => {
      const logoBox = { ...box, surroundColor: '#c62828' };
      expect(
        resolveTalkWindowColor({
          scriptColor: '#f5f5f5',
          logoFace: true,
          logoBox,
          kitColor: '#D32F2F',
          fallback: '#FFFFFF',
        }),
      ).toBe('#F5F5F5');
      expect(
        resolveTalkWindowColor({
          scriptColor: null,
          logoFace: true,
          logoBox,
          kitColor: '#D32F2F',
          fallback: '#FFFFFF',
        }),
      ).toBe('#C62828');
      expect(
        resolveTalkWindowColor({
          scriptColor: '  ',
          logoFace: false,
          logoBox,
          kitColor: '#d32f2f',
          fallback: '#FFFFFF',
        }),
      ).toBe('#D32F2F');
      expect(
        resolveTalkWindowColor({
          logoFace: true,
          logoBox: { ...box, surroundColor: null },
          kitColor: null,
          fallback: '#ffffff',
        }),
      ).toBe('#FFFFFF');
    });

    it('caixa antiga (sem surroundColor) ou cor inválida → vale a cor do kit', () => {
      expect(
        resolveTalkWindowColor({
          logoFace: true,
          logoBox: box,
          kitColor: '#D32F2F',
          fallback: '#FFFFFF',
        }),
      ).toBe('#D32F2F');
      expect(
        resolveTalkWindowColor({
          logoFace: true,
          logoBox: { ...box, surroundColor: 'red' },
          kitColor: '#D32F2F',
          fallback: '#FFFFFF',
        }),
      ).toBe('#D32F2F');
    });
  });

  it('readProjectLogoBox preserva surroundColor válida (maiúscula) e null; descarta inválida', () => {
    const base = {
      ...BOX,
      logoBoxSource: 'layout',
      logoBoxConfidence: null,
      logoBoxConfirmed: true,
    };
    expect(readProjectLogoBox({ ...base, surroundColor: '#c62828' })?.surroundColor).toBe(
      '#C62828',
    );
    expect(readProjectLogoBox({ ...base, surroundColor: null })).toHaveProperty(
      'surroundColor',
      null,
    );
    expect(readProjectLogoBox({ ...base, surroundColor: 'vermelho' })).not.toHaveProperty(
      'surroundColor',
    );
    expect(readProjectLogoBox(base)).not.toHaveProperty('surroundColor');
  });

  it('confirmar a MESMA caixa preserva a cor; marcar outra caixa volta sem cor (o service amostra de novo)', () => {
    const current = stored({ surroundColor: '#C62828' });
    expect(confirmLogoBox(current, { ...BOX })).toMatchObject({
      surroundColor: '#C62828',
      logoBoxConfirmed: true,
    });
    expect(confirmLogoBox(current, { x: 0.3, y: 0.02, w: 0.25, h: 0.08 })).not.toHaveProperty(
      'surroundColor',
    );
  });
});
