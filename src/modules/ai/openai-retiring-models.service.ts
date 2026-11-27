import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getStrongModelConfig } from './config/openai-strong-models.config';
import { PRODUCT_AI_MODEL_VARS, readModelConfig } from './config/openai-product-features.config';

/** Família de texto e visão que a OpenAI desliga em 2027-01-14 (change 42, task 1.1). */
const RETIRING_PREFIX = 'gpt-4o';
const RETIREMENT_DATE = '2027-01-14';

/** Variáveis de modelo de texto ou visão com padrão próprio; `EAN_JUDGE_MODEL_B` entra à parte (herda a A). */
const MODEL_VARS = [
  'OPENAI_TEXT_MODEL',
  'OPENAI_FAST_TEXT_MODEL',
  'MC_DIRECTOR_MODEL',
  'MC_KIT_VISION_MODEL',
  'EAN_JUDGE_MODEL_A',
  ...PRODUCT_AI_MODEL_VARS,
];

/** Variáveis do fallback DALL-E, sem efeito depois da task 1.14 (`dall-e-3` foi desligado em 2026-05-12). */
const DALLE_VARS = ['OPENAI_ENABLE_DALLE_FALLBACK', 'OPENAI_DALLE_FALLBACK_MODEL'];

/**
 * Ao subir (API e worker, que carregam o mesmo `AiModule`), avisa no log cada variável de modelo cujo valor resolvido
 * começa com `gpt-4o` e cada variável do DALL-E definida. Nunca derruba o processo.
 */
@Injectable()
export class OpenAiRetiringModelsWarning implements OnModuleInit {
  private readonly logger = new Logger(OpenAiRetiringModelsWarning.name);

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    for (const line of this.warnings()) this.logger.warn(line);
  }

  warnings(): string[] {
    return [...this.retiringModelLines(), ...this.dalleLines()];
  }

  /** Valor resolvido de cada variável: ausente ou vazia vale o padrão, que nunca é `gpt-4o*`. */
  private retiringModelLines(): string[] {
    const resolved: Array<[string, string]> = MODEL_VARS.map((name) => [
      name,
      readModelConfig(this.config, name, ''),
    ]);
    resolved.push(['EAN_JUDGE_MODEL_B', getStrongModelConfig(this.config).eanJudgeModelB]);
    return resolved
      .filter(([, value]) => value.toLowerCase().startsWith(RETIRING_PREFIX))
      .map(
        ([name, value]) =>
          `${name}=${value} aponta para modelo que a OpenAI desliga em ${RETIREMENT_DATE} (${RETIRING_PREFIX}*). Troque por gpt-6-luna ou gpt-6.1-terra, ou tire a linha do .env para valer o padrão.`,
      );
  }

  private dalleLines(): string[] {
    return DALLE_VARS.filter((name) => readModelConfig(this.config, name, '') !== '').map(
      (name) =>
        `${name} não tem efeito: o fallback DALL-E foi removido (dall-e-3 está desligado). Tire a linha do .env.`,
    );
  }
}
