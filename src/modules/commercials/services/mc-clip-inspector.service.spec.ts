import * as fs from 'fs/promises';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { GeminiImageProvider } from '../../../shared/providers/gemini-image.provider';
import { McClipInspectorService } from './mc-clip-inspector.service';

describe('McClipInspectorService — inspeção de texto inventado no clipe (opção B)', () => {
  it('amostra instantes espalhados, nunca o quadro 0 (keyframe) nem o último', () => {
    expect(McClipInspectorService.sampleTimesS(5000)).toEqual([1, 2, 3, 4]);
    expect(McClipInspectorService.sampleTimesS(0)[0]).toBeGreaterThan(0);
  });

  it('interpreta o JSON do veredito (com ruído em volta) e rejeita respostas inválidas', () => {
    expect(
      McClipInspectorService.parseVerdict(
        '```json\n{"unwanted_text": true, "where": "bottom", "description": "garbled caption"}\n```',
      ),
    ).toEqual({ flagged: true, where: 'bottom', description: 'garbled caption' });
    expect(
      McClipInspectorService.parseVerdict(
        '{"unwanted_text": false, "where": null, "description": ""}',
      ),
    ).toEqual({
      flagged: false,
      where: null,
      description: '',
    });
    expect(McClipInspectorService.parseVerdict('não sei')).toBeNull();
    expect(McClipInspectorService.parseVerdict('{"unwanted_text": "yes"}')).toBeNull();
  });

  it('decisão do ingest: limpo → ok; reprovado → regera até a 3ª execução, depois aceita', () => {
    const flagged = { flagged: true, where: 'top', description: 'sign', frames: 4, model: 'm' };
    expect(McClipInspectorService.decision(null, 1)).toBe('ok');
    expect(McClipInspectorService.decision({ ...flagged, flagged: false }, 1)).toBe('ok');
    expect(McClipInspectorService.decision(flagged, 1)).toBe('retry');
    expect(McClipInspectorService.decision(flagged, 2)).toBe('retry');
    expect(McClipInspectorService.decision(flagged, 3)).toBe('accept');
  });

  it('extrai N quadros por ffmpeg, pergunta ao Gemini e nunca derruba o chamador em erro', async () => {
    const ffmpeg = { run: jest.fn().mockResolvedValue(undefined) };
    const gemini = {
      describeImages: jest
        .fn()
        .mockResolvedValue('{"unwanted_text": true, "where": "top", "description": "sign"}'),
    };
    const service = new McClipInspectorService(
      ffmpeg as unknown as FfmpegRunner,
      gemini as unknown as GeminiImageProvider,
    );
    jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('jpg'));
    const verdict = await service.inspect('/tmp/v.mp4', 5000, '/tmp');
    expect(ffmpeg.run).toHaveBeenCalledTimes(4);
    expect(gemini.describeImages).toHaveBeenCalledWith(
      expect.objectContaining({ images: expect.any(Array) }),
    );
    expect(verdict).toMatchObject({ flagged: true, where: 'top', frames: 4 });

    gemini.describeImages.mockRejectedValue(new Error('rede'));
    await expect(service.inspect('/tmp/v.mp4', 5000, '/tmp')).resolves.toBeNull();

    process.env.MC_CLIP_TEXT_CHECK = 'off';
    await expect(service.inspect('/tmp/v.mp4', 5000, '/tmp')).resolves.toBeNull();
    delete process.env.MC_CLIP_TEXT_CHECK;
  });
});
