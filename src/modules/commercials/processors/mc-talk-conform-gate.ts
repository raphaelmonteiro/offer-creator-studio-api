import { Logger } from '@nestjs/common';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { mcShouldRetry } from '../domain/mc-error-classes';
import {
  MC_CLIP_TOO_SHORT_ERROR_CODE,
  planTalkConform,
  TalkConformInput,
  TalkConformPlan,
} from '../domain/mc-talk-conform-graph';

/** Resultado do portão da conformação: o plano a executar, o veredito original e o aceite por teto esgotado. */
export interface TalkConformGate {
  plan: TalkConformPlan;
  /** Veredito do plano original (`too_short` quando o clipe foi aceito no teto). */
  verdict: TalkConformPlan['durationAction'];
  accepted: { reason: typeof MC_CLIP_TOO_SHORT_ERROR_CODE; executions: number } | null;
}

/**
 * Plano da conformação com a regra da classe `quality` (D7): clipe curto demais (`too_short`) é
 * reprovado para nova geração até o teto; esgotado, vira aceite com o último quadro clonado até o
 * áudio, sinalizado para revisão humana. Compartilhado pelo `talk` de uma fala e pelo de trecho.
 */
export function planConformWithGate(
  input: TalkConformInput,
  step: { id: string; attempts: number },
  logger: Logger,
): TalkConformGate {
  let plan = planTalkConform(input);
  const verdict = plan.durationAction;
  let accepted: TalkConformGate['accepted'] = null;
  if (plan.durationAction === 'too_short') {
    // Classe `quality` (boca parada): nova geração até o teto — a MESMA regra de
    // McClipInspectorService.decision. Esgotado o teto, não vira terminal: o último clipe é aceito
    // com o último quadro clonado até o áudio e a cena fica sinalizada para revisão humana.
    if (mcShouldRetry('quality', step.attempts)) {
      throw new TerminalProviderError(
        `Clipe ${plan.deltaMs} ms mais curto que o áudio (boca parada) — regerar`,
        MC_CLIP_TOO_SHORT_ERROR_CODE,
      );
    }
    logger.warn(
      `Ingest ${step.id}: clipe ${plan.deltaMs} ms mais curto que o áudio após ` +
        `${step.attempts} gerações — aceito com o último quadro clonado (revisão humana)`,
    );
    plan = planTalkConform({ ...input, padMaxMs: Infinity });
    accepted = { reason: MC_CLIP_TOO_SHORT_ERROR_CODE, executions: step.attempts };
  }
  return { plan, verdict, accepted };
}
