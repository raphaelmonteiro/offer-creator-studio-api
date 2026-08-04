import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AnimationTaskType, CreateAnimationTaskDto } from './create-animation-task.dto';
import { CreateRenderJobDto } from './create-render-job.dto';

async function errorsOf(dto: object): Promise<string[]> {
  const errors = await validate(dto, { whitelist: true });
  const flatten = (errs: typeof errors): string[] =>
    errs.flatMap((e) => [
      ...Object.keys(e.constraints ?? {}).map((k) => `${e.property}.${k}`),
      ...flatten(e.children ?? []).map((c) => `${e.property}.${c}`),
    ]);
  return flatten(errors);
}

describe('DTOs — contrato dos endpoints (TDD §4.1)', () => {
  describe('CreateAnimationTaskDto', () => {
    it('background_video válido passa', async () => {
      const dto = plainToInstance(CreateAnimationTaskDto, {
        type: AnimationTaskType.BACKGROUND_VIDEO,
        input: {
          prompt: 'Fundo de hortifruti vibrante',
          aspectRatio: '9:16',
          durationS: 5,
          motionIntensity: 'medium',
        },
      });
      expect(await errorsOf(dto)).toEqual([]);
    });

    it('discriminação por type: input de mascote exige sourceAssetId/engine', async () => {
      const dto = plainToInstance(CreateAnimationTaskDto, {
        type: AnimationTaskType.MASCOT_MOTION,
        input: { motion: 'wave', durationS: 5, intensity: 'subtle' },
      });
      const errors = await errorsOf(dto);
      expect(errors.some((e) => e.includes('sourceAssetId'))).toBe(true);
      expect(errors.some((e) => e.includes('engine'))).toBe(true);
    });

    it('durationS fora de 3–10 é rejeitado', async () => {
      const dto = plainToInstance(CreateAnimationTaskDto, {
        type: AnimationTaskType.BACKGROUND_VIDEO,
        input: { prompt: 'abc', aspectRatio: '1:1', durationS: 30, motionIntensity: 'subtle' },
      });
      expect((await errorsOf(dto)).some((e) => e.includes('durationS'))).toBe(true);
    });

    it('talking_mascot: speechText limitado a 600 chars', async () => {
      const dto = plainToInstance(CreateAnimationTaskDto, {
        type: AnimationTaskType.TALKING_MASCOT,
        input: {
          sourceAssetId: 'a2f4b6c8-1234-4abc-9def-112233445566',
          speechText: 'x'.repeat(601),
          voiceId: 'v1',
          language: 'pt-BR',
          engine: 'heygen_avatar',
        },
      });
      expect((await errorsOf(dto)).some((e) => e.includes('speechText'))).toBe(true);
    });

    it('type inválido é rejeitado', async () => {
      const dto = plainToInstance(CreateAnimationTaskDto, { type: 'hack', input: {} });
      expect((await errorsOf(dto)).some((e) => e.startsWith('type.'))).toBe(true);
    });
  });

  describe('CreateRenderJobDto', () => {
    const validLayer = {
      type: 'video',
      assetId: 'a2f4b6c8-1234-4abc-9def-112233445566',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      startMs: 0,
      loop: true,
      zIndex: 0,
    };
    const validSpec = {
      format: 'mp4',
      width: 1080,
      height: 1920,
      fps: 30,
      durationMs: 5000,
      quality: 'standard',
      layers: [validLayer],
    };

    it('spec válido passa', async () => {
      const dto = plainToInstance(CreateRenderJobDto, { spec: validSpec });
      expect(await errorsOf(dto)).toEqual([]);
    });

    it('anti-SSRF: url externa é rejeitada, /uploads/* é aceita', async () => {
      const external = plainToInstance(CreateRenderJobDto, {
        spec: {
          ...validSpec,
          layers: [{ ...validLayer, assetId: undefined, url: 'https://evil.com/x.mp4' }],
        },
      });
      expect((await errorsOf(external)).some((e) => e.includes('url'))).toBe(true);

      const local = plainToInstance(CreateRenderJobDto, {
        spec: {
          ...validSpec,
          layers: [{ ...validLayer, assetId: undefined, url: '/uploads/animations/u/x.mp4' }],
        },
      });
      expect(await errorsOf(local)).toEqual([]);
    });

    it('frações fora de 0–1 são rejeitadas', async () => {
      const dto = plainToInstance(CreateRenderJobDto, {
        spec: { ...validSpec, layers: [{ ...validLayer, x: 1.5 }] },
      });
      expect((await errorsOf(dto)).some((e) => e.includes('x.'))).toBe(true);
    });

    it('durationMs > 30s e formato desconhecido são rejeitados', async () => {
      const dto = plainToInstance(CreateRenderJobDto, {
        spec: { ...validSpec, format: 'avi', durationMs: 60000 },
      });
      const errors = await errorsOf(dto);
      expect(errors.some((e) => e.includes('format'))).toBe(true);
      expect(errors.some((e) => e.includes('durationMs'))).toBe(true);
    });
  });
});
