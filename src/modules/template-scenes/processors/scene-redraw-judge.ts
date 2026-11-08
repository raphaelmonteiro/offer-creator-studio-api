import { JudgeBriefVerdict } from '../domain/scene-brief';
import { safeChanged, safeSeamDescription } from '../domain/scene-director-phrases';
import { DirectorPlan } from '../domain/scene-director-schema';
import { hasTextError, TextLine } from '../domain/scene-text-check';
import { JudgeFacts, TextFacts } from '../scene-texts';
import { SceneVisionService, VisionAssessment } from '../services/scene-vision.service';
import * as sharp from 'sharp';
import { SceneCallRunner } from './scene-call-runner';
import { CropBox } from './scene-text-crop';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

/** O texto a conferir nesta rodada: as linhas esperadas, as que vêm de versão anterior, e o recorte da região. */
export interface TextPlan {
  expected: string[];
  /** Texto já pintado em versão anterior que não está em `expected`: o juiz não o conta como extra. */
  known: string[];
  /** Posições de `expected` que vêm do texto já pintado na versão atual (D-56), e não do pedido desta rodada. */
  inherited: boolean[];
  crop: CropBox | null;
}

export interface JudgedResult {
  /** `null` quando o juiz não pôde conferir (indisponível, limite de chamadas ou saída inválida). */
  facts: Omit<JudgeFacts, 'text'> | null;
  /** Por que não houve conferência: o limite de chamadas do pedido, ou a saída do juiz não serviu. */
  unavailable?: 'limit' | 'invalid';
  verdict?: JudgeBriefVerdict;
  record: Record<string, unknown>;
  /** A leitura comparada pelo código; vazia sem texto esperado ou sem juiz. */
  textLines: TextLine[];
}

/** A avaliação do juiz que serviu (`ok`). */
type VisionOk = Extract<VisionAssessment, { ok: true }>;

export interface JudgeDeps {
  calls: SceneCallRunner;
  vision: SceneVisionService;
  support: SceneTurnSupport;
}

/** Linha herdada que sumiu da imagem não é erro: o cliente pode ter tirado a placa (PV-83). */
function markGone(lines: TextLine[], inherited: boolean[]): TextLine[] {
  return lines.map((line, index) =>
    inherited[index] && !line.read.trim() ? { ...line, ok: true, gone: true } : line,
  );
}

/** O que o juiz viu, em fatos para o texto ao cliente (já sem promessa de preservação). */
function factsOf(assessment: VisionOk, ctx: TurnContext): NonNullable<JudgedResult['facts']> {
  const labelOf = new Map(ctx.turnItems.map((item) => [item.id, item.text]));
  return {
    satisfied: assessment.satisfied,
    changed: safeChanged(assessment.changed),
    missing: safeChanged(assessment.missing),
    missingAny: assessment.notSeen.map((id) => labelOf.get(id)).filter(Boolean).length > 0,
    extraText: safeChanged(assessment.extraText),
    seam: assessment.seam,
    seamDescription: safeSeamDescription(assessment.seamDescription),
  };
}

/** O juiz não conferiu: não há fatos nem leitura, e o texto ao cliente diz que não conseguiu conferir. */
const withoutJudge = (unavailable: 'limit' | 'invalid'): JudgedResult => ({
  facts: null,
  unavailable,
  record: { available: false },
  textLines: [],
});

/** O registro de auditoria da conferência, em `metrics.judge`. */
function recordOf(assessment: VisionOk, textLines: TextLine[]): Record<string, unknown> {
  return {
    available: true,
    satisfied: assessment.satisfied,
    changed: assessment.changed,
    seen: assessment.seen,
    notSeen: assessment.notSeen,
    missing: assessment.missing,
    extraText: assessment.extraText,
    textLines,
    seam: assessment.seam,
    seamDescription: assessment.seamDescription,
  };
}

/**
 * O juiz depois da imagem: fatos, veredito sobre a lista, a leitura do texto e o registro de auditoria; `'over'` se
 * o turno já acabou (parada ou cena excluída). Com texto esperado, o recorte da região vai como imagem a mais.
 */
export async function judgeResult(
  deps: JudgeDeps,
  ctx: TurnContext,
  input: { plan: DirectorPlan; before: Buffer | null; after: Buffer; text: TextPlan },
): Promise<'over' | JudgedResult> {
  const { calls, vision, support } = deps;
  const { text } = input;
  const call = await calls.visionCall(ctx, {
    model: vision.model(),
    run: async () =>
      vision.assess({
        message: ctx.request,
        plan: input.plan,
        openItems: ctx.turnItems,
        hasBefore: Boolean(input.before),
        expectedText: text.expected,
        knownText: text.known,
        hasCrop: Boolean(text.crop && text.expected.length),
        before: input.before ? await support.judgeImage(input.before) : undefined,
        after: await support.judgeImage(input.after),
        crop:
          text.crop && text.expected.length
            ? await support.judgeImage(await sharp(input.after).extract(text.crop).png().toBuffer())
            : undefined,
        correlationId: ctx.correlationId,
      }),
  });
  if (call.status === 'over') return 'over';
  if (call.status === 'skipped') return withoutJudge('limit');
  if (call.value.ok === false) return withoutJudge('invalid');
  const assessment = call.value;
  const textLines = markGone(assessment.textLines, text.inherited);
  return {
    facts: factsOf(assessment, ctx),
    verdict: { seen: assessment.seen, notSeen: assessment.notSeen },
    textLines,
    record: recordOf(assessment, textLines),
  };
}

/** `judge` no máximo `parcial` enquanto o texto pintado estiver errado (D-51): a tela oferece "Voltar para a anterior". */
export function effectiveSatisfied(
  satisfied: JudgeFacts['satisfied'],
  lines: TextLine[],
): JudgeFacts['satisfied'] {
  return satisfied === 'sim' && hasTextError(lines) ? 'parcial' : satisfied;
}

/** Os fatos de texto que vão ao cliente: só as linhas que ainda estão na imagem. */
export function textFactsOf(
  lines: TextLine[],
  applied: { tried: 1 | 2; limited: boolean; secondFailed: boolean },
): TextFacts | undefined {
  const present = lines.filter((line) => !line.gone);
  if (!present.length) return undefined;
  const { tried, limited, secondFailed } = applied;
  return { lines: present, tried, limited, ...(secondFailed ? { secondFailed } : {}) };
}
