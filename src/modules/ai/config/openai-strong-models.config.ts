import { ConfigService } from '@nestjs/config';
import { readModelConfig } from './openai-product-features.config';

/**
 * Padrão dos pontos que vão para o modelo forte (change 42, D-2): diretor dos comerciais, descrição canônica do kit
 * e os dois juízes de EAN. Cada um tem variável própria e NÃO herda `OPENAI_TEXT_MODEL`; ausente, vazia ou só com
 * espaços vale este. O juiz B ausente segue o A.
 */
export const DEFAULT_STRONG_MODEL = 'gpt-6.1-terra';

export interface StrongModelConfig {
  directorModel: string;
  kitVisionModel: string;
  eanJudgeModelA: string;
  eanJudgeModelB: string;
}

export function getStrongModelConfig(configService: ConfigService): StrongModelConfig {
  const eanJudgeModelA = readModelConfig(configService, 'EAN_JUDGE_MODEL_A', DEFAULT_STRONG_MODEL);
  return {
    directorModel: readModelConfig(configService, 'MC_DIRECTOR_MODEL', DEFAULT_STRONG_MODEL),
    kitVisionModel: readModelConfig(configService, 'MC_KIT_VISION_MODEL', DEFAULT_STRONG_MODEL),
    eanJudgeModelA,
    eanJudgeModelB: readModelConfig(configService, 'EAN_JUDGE_MODEL_B', eanJudgeModelA),
  };
}
