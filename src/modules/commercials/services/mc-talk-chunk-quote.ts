import { EntityManager } from 'typeorm';
import { McQuoteItem, McTalkQuote } from '../domain/mc-quality';
import { MC_STEP_CREDITS } from '../domain/mc-pricing.config';
import { McScript, McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import type { McMaterializerService } from './mc-materializer.service';
import {
  ChunkPlanArgs,
  isContinuousProject,
  PlannedChunk,
  planProjectChunks,
} from './mc-talk-chunk-planner';

/** Cotação, créditos e alcance do reroll do `talk` por trecho (change video-fala-continua, D7/D13, Q2). */

/** Créditos de cada trecho (Q2): cascata não cobra; cache 0; reroll só as falas pedidas; resto, uma por fala. */
export function chunkCredits(chunk: PlannedChunk): number {
  if (chunk.reason === 'cascade' || chunk.reason === 'cached') return 0;
  return chunk.chargedScenes.length * MC_STEP_CREDITS[McStepType.TALK];
}

/** `sceneId` do roteiro das falas que cobram crédito neste trecho (D13, Q2). */
function chunkCharged(chunk: PlannedChunk): string[] {
  if (chunk.reason === 'cascade' || chunk.reason === 'cached') return [];
  return chunk.chargedScenes.map((s) => s.scriptSceneId as string);
}

/** Itens de cotação por fala: só as que cobram; a cascata fica de fora (Q2); o reaproveitado entra a custo 0. */
export function chunkQuoteItems(chunk: PlannedChunk): McQuoteItem[] {
  if (chunk.reason === 'cascade') return [];
  const cached = chunk.reason === 'cached';
  return (cached ? chunk.scenes : chunk.chargedScenes).map((scene) => ({
    sceneId: scene.scriptSceneId as string,
    stepType: McStepType.TALK,
    attempt: chunk.attempt,
    credits: cached ? 0 : MC_STEP_CREDITS[McStepType.TALK],
    cached,
  }));
}

type QuotedChunk = McTalkQuote['chunks'][number];
type TalkContext = Awaited<ReturnType<McMaterializerService['talkProductionContext']>>;

/** Linha da cotação de um trecho (segundos cobrados, custo estimado e as falas que cobram crédito). */
function quoteChunk(c: PlannedChunk, ctx: TalkContext): QuotedChunk {
  const rewrite = c.reason !== 'cached';
  const usd = Number((c.billedSeconds * ctx.engine.usdPerSecond).toFixed(4));
  return {
    index: c.plan.index,
    sceneIds: c.scenes.map((s) => s.scriptSceneId as string),
    chargedSceneIds: chunkCharged(c),
    speechSeconds: Number(
      (c.plan.speeches.reduce((t, s) => t + s.durationMs, 0) / 1000).toFixed(3),
    ),
    billedSeconds: c.billedSeconds,
    rewrite,
    reason: c.reason,
    estimatedUsd: rewrite ? usd : 0,
    engineModel: ctx.engine.model,
    usdPerSecond: ctx.engine.usdPerSecond,
    joinFromIndex: c.plan.joinFromIndex,
  };
}

/** Linhas por fala: o custo do trecho rateado pela duração de cada fala (+ o silêncio ou a cauda que a segue). */
function quoteScenes(
  planned: PlannedChunk[],
  chunks: QuotedChunk[],
  ctx: TalkContext,
): McTalkQuote['scenes'] {
  return planned.flatMap((c) =>
    c.scenes.map((row, i) => {
      const chunk = chunks[c.plan.index];
      const share =
        (chunk.billedSeconds *
          (c.plan.speeches[i].durationMs +
            (i < c.scenes.length - 1 ? c.plan.gapMs : c.plan.tailMs))) /
        Math.max(1, c.plan.audioMs);
      return {
        sceneId: row.scriptSceneId as string,
        idx: row.idx,
        chunkIndex: c.plan.index,
        rewrite: chunk.rewrite,
        billedSeconds: Number(share.toFixed(3)),
        engineModel: ctx.engine.model,
        usdPerSecond: ctx.engine.usdPerSecond,
        estimatedUsd: chunk.rewrite ? Number((share * ctx.engine.usdPerSecond).toFixed(4)) : 0,
      };
    }),
  );
}

/** Cotação do `talk` por trecho (D13): sem chamada paga nem reserva. */
export async function quoteTalkChunks(
  mat: McMaterializerService,
  manager: EntityManager,
  args: ChunkPlanArgs & { mode: McTalkQuote['mode'] },
): Promise<McTalkQuote> {
  const planned = await planProjectChunks(mat, manager, args);
  const ctx = await mat.talkProductionContext(manager, args.project, args.script);
  const chunks = planned.map((c) => quoteChunk(c, ctx));
  const scenes = quoteScenes(planned, chunks, ctx);
  return {
    mode: args.mode,
    chunks,
    scenes,
    rewriteCount: scenes.filter((s) => s.rewrite).length,
    estimatedUsd: Number(chunks.reduce((t, c) => t + c.estimatedUsd, 0).toFixed(4)),
  };
}

/** Alcance de um reroll em modo contínuo: o trecho pedido (todas as falas dele) e os seguintes (cascata, D7). */
export interface ChunkRerollScope {
  /** Índice do primeiro trecho regravado. */
  chunkIndex: number;
  /** `sceneId` do roteiro das falas do(s) trecho(s) pedido(s); as demais falas do trecho são regravadas junto. */
  sceneIds: string[];
  /** `sceneId` do roteiro das falas dos trechos seguintes, regravados só pela junção (sem crédito, Q2). */
  cascadeSceneIds: string[];
  /** Linhas das falas do(s) trecho(s) pedido(s) (inclui as pedidas). */
  regravar: McScene[];
  /** Linhas das falas dos trechos seguintes. */
  cascade: McScene[];
}

/**
 * Quais falas um reroll de `targets` regrava em modo contínuo (D13): o trecho de cada fala pedida e todos
 * os seguintes. `null` fora do modo contínuo (o reroll segue por fala, como hoje).
 */
export async function resolveChunkReroll(
  mat: McMaterializerService,
  manager: EntityManager,
  args: { project: McProject; script: McScript; scenes: McScene[]; targets: McScene[] },
): Promise<ChunkRerollScope | null> {
  if (!isContinuousProject(args.project, args.script)) return null;
  const targetIds = args.targets.map((t) => t.id);
  const planned = await planProjectChunks(mat, manager, {
    project: args.project,
    script: args.script,
    scenes: args.scenes,
    scope: { targetRowIds: targetIds, forceNewAttempt: true },
  });
  const inScope = planned.filter((c) => c.inScope);
  if (inScope.length === 0) return null;
  const requested = inScope.filter((c) => c.scenes.some((s) => targetIds.includes(s.id)));
  const cascade = inScope.filter((c) => !requested.includes(c));
  const ids = (chunks: PlannedChunk[]) =>
    chunks.flatMap((c) => c.scenes.map((s) => s.scriptSceneId as string));
  return {
    chunkIndex: inScope[0].plan.index,
    sceneIds: ids(requested),
    cascadeSceneIds: ids(cascade),
    regravar: requested.flatMap((c) => c.scenes),
    cascade: cascade.flatMap((c) => c.scenes),
  };
}
