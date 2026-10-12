import * as fs from 'fs/promises';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { GeminiImageProvider } from '../../../shared/providers/gemini-image.provider';
import {
  MC_CLIP_MOUTH_STILL_ERROR_CODE,
  MC_CLIP_TEXT_ERROR_CODE,
} from '../domain/mc-error-classes';
import {
  buildClipInspectionPrompt,
  ClipInspection,
  ClipInspectionContext,
  McClipInspectorService,
} from './mc-clip-inspector.service';

const PLAIN_CTX: ClipInspectionContext = {
  source: 'logo',
  style: '3d_render',
  backgroundKind: 'plain',
  speechWindows: [
    { startS: 0.2, endS: 2.4 },
    { startS: 2.9, endS: 4.1 },
    { startS: 4.4, endS: 4.5 }, // curta demais para um par
    { startS: 4.8, endS: 5.9 },
  ],
};

function verdict(overrides: Partial<ClipInspection> = {}): ClipInspection {
  return {
    flagged: false,
    reasons: [],
    where: null,
    description: '',
    frames: 4,
    pairs: 0,
    mouthCheck: 'skipped',
    model: 'm',
    available: true,
    verdict: 'ok',
    ...overrides,
  };
}

describe('McClipInspectorService — inspeção por contexto e janelas de fala (D11)', () => {
  it('amostra instantes espalhados, nunca o quadro 0 (keyframe/tile) nem o último', () => {
    expect(McClipInspectorService.sampleTimesS(5000)).toEqual([1, 2, 3, 4]);
    expect(McClipInspectorService.sampleTimesS(0)[0]).toBeGreaterThan(0);
  });

  it('pares (t, t+0,25 s) dentro das janelas de fala: até 3, as mais longas, cabendo na janela e no clipe', () => {
    const starts = McClipInspectorService.speechPairTimesS(PLAIN_CTX.speechWindows, 6000);
    expect(starts).toHaveLength(3);
    for (const t of starts) {
      const window = PLAIN_CTX.speechWindows.find(
        (w) => t >= w.startS && t + 0.25 <= w.endS + 1e-9,
      );
      expect(window).toBeDefined();
    }
    // janela curta (0,1 s) nunca entra; sem janelas → sem pares
    expect(starts.some((t) => t >= 4.4 && t < 4.8)).toBe(false);
    expect(McClipInspectorService.speechPairTimesS([], 6000)).toEqual([]);
    expect(McClipInspectorService.speechPairTimesS([{ startS: 0, endS: 0.1 }], 6000)).toEqual([]);
    // par precisa caber no clipe: janela que avança além do fim é cortada/descartada
    expect(McClipInspectorService.speechPairTimesS([{ startS: 5.9, endS: 7 }], 6000)).toEqual([]);
  });

  it('interpreta o JSON do veredito (texto, deformação, boca) e rejeita respostas inválidas', () => {
    expect(
      McClipInspectorService.parseVerdict(
        '```json\n{"unwanted_text": true, "where": "bottom", "deformed": false, "mouth_moving": true, "description": "garbled caption"}\n```',
      ),
    ).toEqual({
      flagged: true,
      reasons: ['text'],
      where: 'bottom',
      description: 'garbled caption',
      mouthMoving: true,
    });
    expect(
      McClipInspectorService.parseVerdict(
        '{"unwanted_text": false, "where": null, "deformed": true, "mouth_moving": false, "description": "melted face"}',
      ),
    ).toMatchObject({ flagged: true, reasons: ['deformation', 'mouth_still'], where: null });
    // resposta no formato antigo (sem deformed/mouth_moving) continua válida
    expect(
      McClipInspectorService.parseVerdict(
        '{"unwanted_text": false, "where": null, "description": ""}',
      ),
    ).toEqual({ flagged: false, reasons: [], where: null, description: '', mouthMoving: null });
    expect(McClipInspectorService.parseVerdict('não sei')).toBeNull();
    expect(McClipInspectorService.parseVerdict('{"unwanted_text": "yes"}')).toBeNull();
  });

  it('decisão do ingest: limpo/não inspecionado → ok; reprovado → regera até a 3ª execução, depois aceita', () => {
    const flagged = verdict({ flagged: true, reasons: ['text'], where: 'top' });
    expect(McClipInspectorService.decision(null, 1)).toBe('ok');
    expect(McClipInspectorService.decision(verdict(), 1)).toBe('ok');
    expect(
      McClipInspectorService.decision(
        verdict({ available: false, verdict: 'não inspecionado' }),
        1,
      ),
    ).toBe('ok');
    expect(McClipInspectorService.decision(flagged, 1)).toBe('retry');
    expect(McClipInspectorService.decision(flagged, 2)).toBe('retry');
    expect(McClipInspectorService.decision(flagged, 3)).toBe('accept');
    expect(McClipInspectorService.errorCodeFor(flagged)).toBe(MC_CLIP_TEXT_ERROR_CODE);
    expect(
      McClipInspectorService.errorCodeFor(verdict({ flagged: true, reasons: ['mouth_still'] })),
    ).toBe(MC_CLIP_MOUTH_STILL_ERROR_CODE);
  });

  it('prompt dirigido pelo contexto: fundo liso não presume loja; logo e estilo entram; pares só quando há janelas', () => {
    const plain = buildClipInspectionPrompt(PLAIN_CTX, 3);
    expect(plain).toContain('PLAIN solid-color background');
    expect(plain).toContain('brand logo character');
    expect(plain).toContain('3D animated-feature style');
    expect(plain).toContain('3 PAIRS of consecutive frames');
    expect(plain).not.toMatch(/store aisle/);
    expect(plain).not.toMatch(/product package/);

    const scene = buildClipInspectionPrompt(
      { source: 'mascot', style: null, backgroundKind: 'scene', speechWindows: [] },
      0,
    );
    expect(scene).toContain('mascot character');
    expect(scene).toContain('real product package');
    expect(scene).toContain('mouth_moving=null');
    expect(scene).not.toContain('PAIRS');
  });

  describe('inspect()', () => {
    let ffmpeg: { run: jest.Mock };
    let gemini: { describeImages: jest.Mock };
    let service: McClipInspectorService;

    beforeEach(() => {
      ffmpeg = { run: jest.fn().mockResolvedValue(undefined) };
      gemini = { describeImages: jest.fn() };
      service = new McClipInspectorService(
        ffmpeg as unknown as FfmpegRunner,
        gemini as unknown as GeminiImageProvider,
      );
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('jpg'));
      delete process.env.MC_CLIP_TEXT_CHECK;
    });

    afterEach(() => {
      jest.restoreAllMocks();
      delete process.env.MC_CLIP_TEXT_CHECK;
    });

    it('boca parada: 4 quadros espalhados + 3 pares nas janelas; mouth_moving=false ⇒ reprovado por mouth_still', async () => {
      gemini.describeImages.mockResolvedValue(
        '{"unwanted_text": false, "where": null, "deformed": false, "mouth_moving": false, "description": "mouth frozen"}',
      );
      const result = await service.inspect('/tmp/v.mp4', 6000, '/tmp', PLAIN_CTX);
      expect(ffmpeg.run).toHaveBeenCalledTimes(4 + 3 * 2);
      const prompt = (gemini.describeImages.mock.calls[0][0] as { prompt: string }).prompt;
      expect(prompt).toContain('PAIRS');
      expect(prompt).toContain('PLAIN solid-color background');
      expect(result).toMatchObject({
        flagged: true,
        reasons: ['mouth_still'],
        frames: 10,
        pairs: 3,
        mouthCheck: 'still',
        available: true,
        verdict: 'reprovado',
      });
      expect(McClipInspectorService.decision(result, 1)).toBe('retry');
      expect(McClipInspectorService.errorCodeFor(result)).toBe(MC_CLIP_MOUTH_STILL_ERROR_CODE);
    });

    it('sem alinhamento (sem janelas): só a checagem de boca é pulada e registrada; texto e deformação seguem', async () => {
      gemini.describeImages.mockResolvedValue(
        '{"unwanted_text": true, "where": "top", "deformed": false, "mouth_moving": false, "description": "sign"}',
      );
      const result = await service.inspect('/tmp/v.mp4', 6000, '/tmp', {
        ...PLAIN_CTX,
        speechWindows: [],
      });
      expect(ffmpeg.run).toHaveBeenCalledTimes(4);
      expect(result).toMatchObject({
        flagged: true,
        reasons: ['text'], // mouth_moving=false ignorado sem pares
        pairs: 0,
        mouthCheck: 'skipped',
        available: true,
      });
      gemini.describeImages.mockResolvedValue(
        '{"unwanted_text": false, "where": null, "deformed": false, "mouth_moving": null, "description": ""}',
      );
      const clean = await service.inspect('/tmp/v.mp4', 6000, '/tmp', {
        ...PLAIN_CTX,
        speechWindows: [],
      });
      expect(clean).toMatchObject({ flagged: false, mouthCheck: 'skipped', verdict: 'ok' });
    });

    it('boca em movimento nos pares ⇒ mouthCheck checked e clipe ok', async () => {
      gemini.describeImages.mockResolvedValue(
        '{"unwanted_text": false, "where": null, "deformed": false, "mouth_moving": true, "description": ""}',
      );
      const result = await service.inspect('/tmp/v.mp4', 6000, '/tmp', PLAIN_CTX);
      expect(result).toMatchObject({ flagged: false, mouthCheck: 'checked', verdict: 'ok' });
    });

    it('inspeção indisponível (erro do provider, resposta ilegível ou desligada) ⇒ aceito como "não inspecionado"', async () => {
      gemini.describeImages.mockRejectedValue(new Error('rede'));
      const failed = await service.inspect('/tmp/v.mp4', 6000, '/tmp', PLAIN_CTX);
      expect(failed).toMatchObject({
        flagged: false,
        available: false,
        verdict: 'não inspecionado',
        mouthCheck: 'skipped',
      });
      expect(McClipInspectorService.decision(failed, 1)).toBe('ok');

      gemini.describeImages.mockResolvedValue('sem json');
      const garbled = await service.inspect('/tmp/v.mp4', 6000, '/tmp', PLAIN_CTX);
      expect(garbled).toMatchObject({ available: false, verdict: 'não inspecionado' });

      process.env.MC_CLIP_TEXT_CHECK = 'off';
      const off = await service.inspect('/tmp/v.mp4', 6000, '/tmp', PLAIN_CTX);
      expect(off).toMatchObject({ available: false, verdict: 'não inspecionado' });
      expect(gemini.describeImages).toHaveBeenCalledTimes(2); // desligado não chama o provider
    });

    it('chamada legada (sem contexto) usa cena gerada de mascote, sem pares', async () => {
      gemini.describeImages.mockResolvedValue(
        '{"unwanted_text": false, "where": null, "description": ""}',
      );
      const result = await service.inspect('/tmp/v.mp4', 5000, '/tmp');
      expect(ffmpeg.run).toHaveBeenCalledTimes(4);
      const prompt = (gemini.describeImages.mock.calls[0][0] as { prompt: string }).prompt;
      expect(prompt).toContain('real product package');
      expect(result).toMatchObject({ flagged: false, pairs: 0, mouthCheck: 'skipped' });
    });
  });
});
