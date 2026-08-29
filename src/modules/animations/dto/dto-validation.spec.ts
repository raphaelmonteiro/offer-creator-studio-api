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

    describe('mascot_motion — formulário de Animar Mascote (TDD i2v §8.4)', () => {
      const valido = {
        type: AnimationTaskType.MASCOT_MOTION,
        input: {
          mascotId: 'a2f4b6c8-1234-4abc-9def-112233445566',
          preset: 'wave',
          prompt: 'faça ele dar tchau com a mão direita',
          engine: 'fal_kling',
          durationS: 5,
          intensity: 'medium',
        },
      };

      it('payload do formulário passa', async () => {
        expect(await errorsOf(plainToInstance(CreateAnimationTaskDto, valido))).toEqual([]);
      });

      it('aceita mascotId OU sourceAssetId, mas exige um dos dois', async () => {
        const semNenhum = plainToInstance(CreateAnimationTaskDto, {
          ...valido,
          input: { ...valido.input, mascotId: undefined },
        });
        expect((await errorsOf(semNenhum)).some((e) => e.includes('mascotId'))).toBe(true);

        const porAsset = plainToInstance(CreateAnimationTaskDto, {
          ...valido,
          input: {
            ...valido.input,
            mascotId: undefined,
            sourceAssetId: 'a2f4b6c8-1234-4abc-9def-112233445566',
          },
        });
        expect(await errorsOf(porAsset)).toEqual([]);
      });

      it('preset fora do catálogo é rejeitado', async () => {
        const dto = plainToInstance(CreateAnimationTaskDto, {
          ...valido,
          input: { ...valido.input, preset: 'moonwalk' },
        });
        expect((await errorsOf(dto)).some((e) => e.includes('preset'))).toBe(true);
      });

      it('prompt livre é opcional e limitado a 600 caracteres', async () => {
        const semPrompt = plainToInstance(CreateAnimationTaskDto, {
          ...valido,
          input: { ...valido.input, prompt: undefined },
        });
        expect(await errorsOf(semPrompt)).toEqual([]);

        const longo = plainToInstance(CreateAnimationTaskDto, {
          ...valido,
          input: { ...valido.input, prompt: 'x'.repeat(601) },
        });
        expect((await errorsOf(longo)).some((e) => e.includes('prompt'))).toBe(true);
      });

      it('opções avançadas são opcionais e validadas', async () => {
        const completo = plainToInstance(CreateAnimationTaskDto, {
          ...valido,
          input: {
            ...valido.input,
            aspectRatio: '9:16',
            fixedCamera: true,
            removeHandheldObjects: true,
            backgroundMode: 'solid',
            backgroundColor: '#1E90FF',
          },
        });
        expect(await errorsOf(completo)).toEqual([]);
      });

      it('fundo transparente NÃO é aceito nesta entrega (§7.2)', async () => {
        const dto = plainToInstance(CreateAnimationTaskDto, {
          ...valido,
          input: { ...valido.input, backgroundMode: 'transparent' },
        });
        expect((await errorsOf(dto)).some((e) => e.includes('backgroundMode'))).toBe(true);
      });

      it('imageUrl vindo do cliente é descartado pelo whitelist (anti-SSRF)', async () => {
        const dto = plainToInstance(CreateAnimationTaskDto, {
          ...valido,
          input: { ...valido.input, imageUrl: 'http://169.254.169.254/latest/meta-data' },
        });
        await validate(dto, { whitelist: true });
        expect('imageUrl' in (dto.input as unknown as Record<string, unknown>)).toBe(false);
      });
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
