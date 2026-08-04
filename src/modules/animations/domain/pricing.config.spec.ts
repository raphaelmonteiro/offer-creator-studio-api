import { buildPipeline, pipelineTotalCost } from './pricing.config';
import { AnimationTaskType } from '../dto/create-animation-task.dto';

describe('pricing.config — pipelines e custos (TDD §5.5)', () => {
  it('background 5s só com prompt: gera a imagem base no OpenAI (2 + 20 = 22 créditos)', () => {
    // image_to_video exige imagem de entrada — sem referência, a base é obrigatória
    const steps = buildPipeline(AnimationTaskType.BACKGROUND_VIDEO, { durationS: 5 });
    expect(steps.map((s) => s.key)).toEqual(['base_image', 'video']);
    expect(steps[0].provider).toBe('openai');
    expect(pipelineTotalCost(steps)).toBe(22);
  });

  it('background 5s com imagem de referência: só a etapa de vídeo (20 créditos)', () => {
    const steps = buildPipeline(AnimationTaskType.BACKGROUND_VIDEO, {
      durationS: 5,
      referenceAssetId: 'a1b2c3d4-0000-4000-8000-000000000000',
    });
    expect(steps.map((s) => s.key)).toEqual(['video']);
    expect(pipelineTotalCost(steps)).toBe(20);
  });

  it('background 10s com base OpenAI: 2 + 40 = 42 créditos', () => {
    const steps = buildPipeline(AnimationTaskType.BACKGROUND_VIDEO, {
      durationS: 10,
      baseImageEngine: 'openai',
    });
    expect(steps.map((s) => s.key)).toEqual(['base_image', 'video']);
    expect(pipelineTotalCost(steps)).toBe(42);
  });

  it('mascote falando com HeyGen: TTS (2) + avatar (30) = 32 — cenário do ledger', () => {
    const steps = buildPipeline(AnimationTaskType.TALKING_MASCOT, { engine: 'heygen_avatar' });
    expect(steps.map((s) => s.provider)).toEqual(['elevenlabs', 'heygen']);
    expect(pipelineTotalCost(steps)).toBe(32);
  });

  it('mascote falando cartoon: TTS (2) + Kling (15) = 17', () => {
    const steps = buildPipeline(AnimationTaskType.TALKING_MASCOT, { engine: 'fal_kling_cartoon' });
    expect(pipelineTotalCost(steps)).toBe(17);
  });

  it('TTS avulso custa 2', () => {
    expect(pipelineTotalCost(buildPipeline(AnimationTaskType.VOICE_TTS, {}))).toBe(2);
  });
});
