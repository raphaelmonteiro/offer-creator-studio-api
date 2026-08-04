import { AnimationTaskType } from '../dto/create-animation-task.dto';

/**
 * Tabela de créditos por etapa de pipeline (TDD §5.5).
 * 1 crédito = R$ 0,10 (referência). Nunca hardcodar custos nos services —
 * este arquivo é a fonte única, revisável sem tocar em lógica.
 */
export const STEP_CREDIT_COSTS = {
  base_image_openai: 2,
  base_image_runway: 3,
  background_video_5s: 20,
  background_video_10s: 40,
  mascot_motion_kling: 15,
  mascot_motion_runway: 20,
  tts_elevenlabs: 2,
  talking_avatar_heygen: 30,
  render_export: 0,
} as const;

export type StepCostKey = keyof typeof STEP_CREDIT_COSTS;

export interface PipelineStep {
  key: string; // identificador da etapa dentro da task (ex.: 'tts', 'video')
  label: string; // exibido na UI ("Gerando voz…")
  costKey: StepCostKey;
  provider: 'openai' | 'runway' | 'fal_kling' | 'elevenlabs' | 'heygen' | 'internal';
}

/** Monta o pipeline (e portanto o custo total de reserva) de cada tipo de task. */
export function buildPipeline(
  type: AnimationTaskType,
  input: Record<string, unknown>,
): PipelineStep[] {
  switch (type) {
    case AnimationTaskType.BACKGROUND_VIDEO: {
      const steps: PipelineStep[] = [];
      // image_to_video exige uma imagem de entrada: sem asset de referência é
      // obrigatório gerar a base antes, e o default é OpenAI.
      const engine = input.baseImageEngine ?? (input.referenceAssetId ? null : 'openai');
      if (engine === 'runway_gen4') {
        steps.push({
          key: 'base_image',
          label: 'Preparando imagem base',
          costKey: 'base_image_runway',
          provider: 'runway',
        });
      } else if (engine === 'openai') {
        steps.push({
          key: 'base_image',
          label: 'Preparando imagem base',
          costKey: 'base_image_openai',
          provider: 'openai',
        });
      }
      const long = Number(input.durationS) > 5;
      steps.push({
        key: 'video',
        label: 'Animando cena',
        costKey: long ? 'background_video_10s' : 'background_video_5s',
        provider: 'runway',
      });
      return steps;
    }
    case AnimationTaskType.MASCOT_MOTION:
      return [
        input.engine === 'runway'
          ? {
              key: 'video',
              label: 'Animando mascote',
              costKey: 'mascot_motion_runway',
              provider: 'runway',
            }
          : {
              key: 'video',
              label: 'Animando mascote',
              costKey: 'mascot_motion_kling',
              provider: 'fal_kling',
            },
      ];
    case AnimationTaskType.VOICE_TTS:
      return [
        { key: 'tts', label: 'Gerando voz', costKey: 'tts_elevenlabs', provider: 'elevenlabs' },
      ];
    case AnimationTaskType.TALKING_MASCOT: {
      const steps: PipelineStep[] = [
        { key: 'tts', label: 'Gerando voz', costKey: 'tts_elevenlabs', provider: 'elevenlabs' },
      ];
      if (input.engine === 'heygen_avatar') {
        steps.push({
          key: 'video',
          label: 'Gerando avatar falando',
          costKey: 'talking_avatar_heygen',
          provider: 'heygen',
        });
      } else {
        steps.push({
          key: 'video',
          label: 'Animando mascote falando',
          costKey: 'mascot_motion_kling',
          provider: 'fal_kling',
        });
      }
      return steps;
    }
    default:
      throw new Error(`Tipo de task desconhecido: ${type}`);
  }
}

export function stepCost(step: PipelineStep): number {
  return STEP_CREDIT_COSTS[step.costKey];
}

export function pipelineTotalCost(steps: PipelineStep[]): number {
  return steps.reduce((sum, s) => sum + stepCost(s), 0);
}
