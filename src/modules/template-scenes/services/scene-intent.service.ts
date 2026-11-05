import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INTENT_JSON_SCHEMA, parseIntent, SceneIntent } from '../domain/scene-intent';
import {
  buildIntentSystemPrompt,
  buildIntentUserPrompt,
  IntentPromptContext,
} from '../domain/scene-intent-prompt';
import { SCENE_INTENT_CLIENT, SceneIntentClient } from '../providers/scene-intent-client';
import { visionCostUsd } from './scene-vision.service';

export const DEFAULT_INTENT_MODEL = 'gpt-6-luna';
/** D-19: tempo máximo da chamada; passou disso, o pedido cai no caminho de falha, sem gastar imagem. */
export const DEFAULT_INTENT_TIMEOUT_MS = 8000;

export type IntentStatus = 'ok' | 'invalid' | 'timeout' | 'error';

/** O que fica em `metrics.intent` da versão (o custo soma em `providerCostUsd`, fora de `metrics.calls`). */
export interface IntentMetrics {
  model: string;
  status: IntentStatus;
  costUsd: number | null;
  latencyMs: number;
  requestId: string | null;
}

export type IntentOutcome =
  | { status: 'ok'; intent: SceneIntent; metrics: IntentMetrics }
  | { status: Exclude<IntentStatus, 'ok'>; metrics: IntentMetrics };

/** Corrida entre a chamada e o relógio; o relógio é desligado quando a chamada termina primeiro. */
async function withTimeout<T>(call: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([call, clock]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reconhece a intenção da mensagem (D-19): `gpt-6-luna`, só texto, sem histórico, uma chamada sem
 * retentativa. Nunca lança: JSON ou schema recusado, tempo esgotado e indisponibilidade viram um
 * status, e o pedido segue o caminho de falha sem chamada de imagem.
 */
@Injectable()
export class SceneIntentService {
  private readonly logger = new Logger(SceneIntentService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(SCENE_INTENT_CLIENT) private readonly client: SceneIntentClient,
  ) {}

  model(): string {
    return this.config.get<string>('TEMPLATE_SCENE_INTENT_MODEL', DEFAULT_INTENT_MODEL);
  }

  private timeoutMs(): number {
    const value = Number(
      this.config.get<string>(
        'TEMPLATE_SCENE_INTENT_TIMEOUT_MS',
        String(DEFAULT_INTENT_TIMEOUT_MS),
      ),
    );
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTENT_TIMEOUT_MS;
  }

  async classify(input: {
    message: string;
    context: IntentPromptContext;
    correlationId: string;
  }): Promise<IntentOutcome> {
    const { message, context, correlationId } = input;
    const model = this.model();
    const timeoutMs = this.timeoutMs();
    const startedAt = Date.now();
    const metrics = (extra: Partial<IntentMetrics>): IntentMetrics => ({
      model,
      status: 'error',
      costUsd: null,
      latencyMs: Date.now() - startedAt,
      requestId: null,
      ...extra,
    });
    try {
      const outcome = await withTimeout(
        this.client.classify({
          model,
          system: buildIntentSystemPrompt(context),
          user: buildIntentUserPrompt(message),
          jsonSchema: INTENT_JSON_SCHEMA,
          timeoutMs,
          correlationId,
          message,
          marked: context.marked,
        }),
        timeoutMs,
      );
      if (outcome === 'timeout')
        return { status: 'timeout', metrics: metrics({ status: 'timeout' }) };
      const costUsd = visionCostUsd(model, outcome.usage);
      const parsed = parseIntent(outcome.text, message);
      const done = { costUsd, latencyMs: outcome.latencyMs, requestId: outcome.requestId };
      if (parsed.ok === false) {
        this.logger.warn(`Intenção recusada (correlationId=${correlationId}): ${parsed.reason}`);
        return { status: 'invalid', metrics: metrics({ ...done, status: 'invalid' }) };
      }
      return { status: 'ok', intent: parsed.intent, metrics: metrics({ ...done, status: 'ok' }) };
    } catch (error) {
      this.logger.warn(
        `Intenção falhou (correlationId=${correlationId}): ${(error as Error).message}`,
      );
      return { status: 'error', metrics: metrics({ status: 'error' }) };
    }
  }
}
