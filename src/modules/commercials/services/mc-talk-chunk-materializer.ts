import { EntityManager, In } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { McTalkChunkReason, McQuoteItem, McTalkQuote } from '../domain/mc-quality';
import { MC_STEP_CREDITS } from '../domain/mc-pricing.config';
import { effectiveScenePrompts } from '../domain/mc-script-v2';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import {
  buildChunkTalkStep,
  ChunkStepOutput,
  readChunkSnapshot,
} from '../domain/mc-talk-chunk-step';
import { planTalkChunks, TalkChunkPlan } from '../domain/mc-talk-chunks';
import { talkChunkMaxS } from '../domain/mc-talk-continuous.config';
import { McScript, McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import type { McMaterializerService } from './mc-materializer.service';

/**
 * Materialização do `talk` por TRECHO (change video-fala-continua, D4/D6/D7/D10/D13). Funções que
 * recebem o `McMaterializerService` (createStep, cache e tentativas ficam lá) — o plano é função
 * pura de (roteiro, durações medidas dos TTS, motor, flag), recalculado a cada uso, sem coluna.
 */

/** Projeto em modo contínuo (congelado no roteiro, D2). */
export function isContinuousProject(
  project: Pick<McProject, 'format'>,
  script: McScript | null | undefined,
): boolean {
  return (
    script?.talkMode === 'continuous' &&
    (project.format === 'talking_art' || project.format === 'offer_piece')
  );
}

/** Escopo da regravação: quais cenas foram pedidas (reroll) — o trecho delas e os seguintes entram. */
export interface ChunkScope {
  targetRowIds: string[];
  forceNewAttempt: boolean;
}

export interface PlannedChunk {
  plan: TalkChunkPlan;
  scenes: McScene[];
  leader: McScene;
  output: ChunkStepOutput;
  attempt: number;
  cached: { stepId: string; outputAssetId: string } | null;
  reason: McTalkChunkReason;
  /** O trecho será (re)gravado/consultado nesta rodada. */
  inScope: boolean;
  /** Cenas pedidas dentro do trecho (reroll); todas as cenas fora de reroll. */
  chargedScenes: McScene[];
  billedSeconds: number;
}

export interface ChunkPlanArgs {
  project: McProject;
  script: McScript;
  /** TODAS as cenas vivas do projeto. */
  scenes: McScene[];
  scope?: ChunkScope | null;
}

const DONE: McStepStatus[] = [McStepStatus.SUCCEEDED, McStepStatus.SKIPPED_CACHED];

async function audioDurations(
  manager: EntityManager,
  scenes: McScene[],
): Promise<Map<string, number>> {
  const ids = scenes.map((s) => s.audioAssetId).filter((id): id is string => !!id);
  const rows = ids.length ? await manager.find(AnimationAsset, { where: { id: In(ids) } }) : [];
  return new Map(rows.map((a) => [a.id, a.durationMs ?? 0]));
}

/** Cenas `talk_tile` do roteiro com áudio, na ordem do vídeo. */
function talkScenes(script: McScript, scenes: McScene[]): McScene[] {
  const talkIds = new Set(
    script.scenes.filter((s) => s.sceneType === 'talk_tile').map((s) => s.sceneId),
  );
  return scenes
    .filter((s) => s.status !== McSceneStatus.CANCELED && talkIds.has(s.scriptSceneId as string))
    .sort((a, b) => a.idx - b.idx);
}

async function latestTalkStep(manager: EntityManager, sceneId: string): Promise<McStep | null> {
  const rows = await manager.find(McStep, { where: { sceneId, type: McStepType.TALK } });
  rows.sort((a, b) => (b.attempt ?? 1) - (a.attempt ?? 1));
  return rows[0] ?? null;
}

async function classifyReason(
  manager: EntityManager,
  args: { planned: Omit<PlannedChunk, 'reason'>; rerollTarget: boolean },
): Promise<McTalkChunkReason> {
  const { planned } = args;
  if (args.rerollTarget) return 'reroll';
  if (planned.cached) return 'cached';
  const prior = await manager.find(McStep, {
    where: { sceneId: planned.leader.id, type: McStepType.TALK },
  });
  if (prior.length === 0) return 'new';
  // mesmo conteúdo do trecho, hash diferente só pela junção ⇒ regravado por cascata (Q2)
  const sameContent = prior.some(
    (s) =>
      DONE.includes(s.status) &&
      readChunkSnapshot(s.inputSnapshot)?.ownHash === planned.output.ownHash,
  );
  return sameContent ? 'cascade' : 'edited';
}

/**
 * Plano de trechos do projeto com hash, tentativa, cache e motivo de cada um. `scope` (reroll)
 * limita aos trechos pedidos e aos seguintes (cascata, D7); sem `scope`, todos.
 */
export async function planProjectChunks(
  mat: McMaterializerService,
  manager: EntityManager,
  args: ChunkPlanArgs,
): Promise<PlannedChunk[]> {
  const { project, script } = args;
  const ctx = await mat.talkProductionContext(manager, project, script);
  const rows = talkScenes(script, args.scenes);
  const durations = await audioDurations(manager, rows);
  for (const row of rows) {
    if (!row.audioAssetId) throw new Error(`Cena ${row.scriptSceneId}: sem áudio selecionado`);
  }
  const { chunks, blocked } = planTalkChunks({
    speeches: rows.map((r) => ({
      sceneId: r.id,
      durationMs: durations.get(r.audioAssetId as string) || r.durationS * 1000,
    })),
    engineModel: ctx.engine.model,
    engineMaxChunkS: ctx.engine.maxChunkS,
    chunkMaxS: talkChunkMaxS(),
  });
  if (blocked.length > 0) {
    throw new Error(`Fala acima do limite do motor: ${blocked.map((b) => b.sceneId).join(', ')}`);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const targets = new Set(args.scope?.targetRowIds ?? []);
  const firstTarget = args.scope
    ? chunks.findIndex((c) => c.sceneIds.some((id) => targets.has(id)))
    : 0;
  const planned: PlannedChunk[] = [];
  for (const plan of chunks) {
    const scenes = plan.sceneIds.map((id) => byId.get(id) as McScene);
    const leader = scenes[0];
    const inScope = !args.scope || (firstTarget >= 0 && plan.index >= firstTarget);
    const isTarget = !!args.scope && plan.sceneIds.some((id) => targets.has(id));
    const attempt =
      isTarget && args.scope?.forceNewAttempt
        ? await mat.nextAttemptFor(manager, leader, McStepType.TALK)
        : await mat.currentOrFirstAttemptFor(manager, leader, McStepType.TALK);
    const prev = planned[plan.index - 1];
    const join = prev
      ? { fromStepHash: await previousHash(manager, prev), fromSceneRowId: prev.leader.id }
      : null;
    const scriptScene = script.scenes.find((s) => s.sceneId === leader.scriptSceneId);
    const prompts = scriptScene ? effectiveScenePrompts(scriptScene) : null;
    const output = buildChunkTalkStep({
      ctx,
      chunk: plan,
      speeches: scenes.map((s) => ({
        sceneRowId: s.id,
        sceneId: s.scriptSceneId as string,
        audioAssetId: s.audioAssetId as string,
      })),
      join,
      motion: (prompts?.motion ?? scriptScene?.actionPrompt ?? '').trim(),
      lang: prompts?.lang ?? 'pt',
      sceneType: scriptScene?.sceneType,
      attempt,
      count: chunks.length,
    });
    const rerollTarget = isTarget && args.scope?.forceNewAttempt === true;
    const cached = rerollTarget
      ? null
      : await mat.findCachedOutput(manager, project.userId, McStepType.TALK, output.inputHash);
    const charged = isTarget && args.scope ? scenes.filter((s) => targets.has(s.id)) : scenes;
    const base = {
      plan,
      scenes,
      leader,
      output,
      attempt,
      cached,
      inScope,
      chargedScenes: charged,
      billedSeconds: Number((plan.sentMs / 1000).toFixed(3)),
    };
    planned.push({
      ...base,
      reason: await classifyReason(manager, { planned: base, rerollTarget }),
    });
  }
  return planned;
}

/** Hash que o trecho seguinte encadeia: o do step corrente do trecho (se existe e está fora do escopo) ou o recalculado. */
async function previousHash(manager: EntityManager, prev: PlannedChunk): Promise<string> {
  if (prev.inScope) return prev.output.inputHash;
  const existing = await latestTalkStep(manager, prev.leader.id);
  return existing?.inputHash ?? prev.output.inputHash;
}

/** Créditos de cada trecho (Q2): cascata não cobra; cache 0; reroll só as falas pedidas; resto, uma por fala. */
export function chunkCredits(chunk: PlannedChunk): number {
  if (chunk.reason === 'cascade' || chunk.reason === 'cached') return 0;
  return chunk.chargedScenes.length * MC_STEP_CREDITS[McStepType.TALK];
}

/** Itens de cotação por fala; cascata fica de fora (Q2). */
export function chunkQuoteItems(chunk: PlannedChunk): McQuoteItem[] {
  if (chunk.reason === 'cascade') return [];
  const cached = chunk.reason === 'cached';
  return chunk.chargedScenes.map((scene) => ({
    sceneId: scene.scriptSceneId as string,
    stepType: McStepType.TALK,
    attempt: chunk.attempt,
    credits: cached ? 0 : MC_STEP_CREDITS[McStepType.TALK],
    cached,
  }));
}

/** Cena pronta com o clipe `assetId` (atalho de cache; sem transição de estado, como o cache de hoje). */
async function markReady(manager: EntityManager, scene: McScene, assetId: string): Promise<void> {
  await manager.update(
    McScene,
    { id: scene.id },
    { status: McSceneStatus.READY, finalAssetId: assetId, errorCode: null, errorMessage: null },
  );
  scene.status = McSceneStatus.READY;
  scene.finalAssetId = assetId;
}

/** Trecho em cache: a líder aponta a fatia reaproveitada e as seguidoras religam as suas (metadata.chunkSlices). */
async function rehydrateCachedChunk(
  manager: EntityManager,
  chunk: PlannedChunk,
  outputAssetId: string,
): Promise<void> {
  const asset = await manager.findOne(AnimationAsset, { where: { id: outputAssetId } });
  const slices = (asset?.metadata as { chunkSlices?: Array<{ assetId: string }> } | null)
    ?.chunkSlices;
  await markReady(manager, chunk.leader, outputAssetId);
  if (!slices || slices.length !== chunk.scenes.length) return;
  for (const [i, scene] of chunk.scenes.entries()) {
    if (i > 0) await markReady(manager, scene, slices[i].assetId);
  }
}

/** Cria o step `talk` de cada trecho no escopo; cache religa as fatias. Devolve steps e itens da cotação. */
export async function materializeTalkChunks(
  mat: McMaterializerService,
  manager: EntityManager,
  args: ChunkPlanArgs,
): Promise<{ steps: McStep[]; items: McQuoteItem[] }> {
  const planned = await planProjectChunks(mat, manager, args);
  const steps: McStep[] = [];
  const items: McQuoteItem[] = [];
  for (const chunk of planned) {
    if (!chunk.inScope) continue;
    const step = await mat.createChunkStep(manager, args.project, chunk.leader, {
      inputHash: chunk.output.inputHash,
      snapshot: chunk.output.snapshot,
      attempt: chunk.attempt,
      cachedAssetId: chunk.cached?.outputAssetId ?? null,
      costCredits: chunkCredits(chunk),
    });
    steps.push(step);
    items.push(...chunkQuoteItems(chunk));
    if (step.status === McStepStatus.SKIPPED_CACHED && step.outputAssetId) {
      await rehydrateCachedChunk(manager, chunk, step.outputAssetId);
    }
  }
  return { steps, items };
}

/** Cotação do `talk` por trecho (D13): sem chamada paga nem reserva. */
export async function quoteTalkChunks(
  mat: McMaterializerService,
  manager: EntityManager,
  args: ChunkPlanArgs & { mode: McTalkQuote['mode'] },
): Promise<McTalkQuote> {
  const planned = await planProjectChunks(mat, manager, args);
  const ctx = await mat.talkProductionContext(manager, args.project, args.script);
  const usd = (seconds: number) => Number((seconds * ctx.engine.usdPerSecond).toFixed(4));
  const chunks = planned.map((c) => {
    const rewrite = c.reason !== 'cached';
    return {
      index: c.plan.index,
      sceneIds: c.scenes.map((s) => s.scriptSceneId as string),
      speechSeconds: Number(
        (c.plan.speeches.reduce((t, s) => t + s.durationMs, 0) / 1000).toFixed(3),
      ),
      billedSeconds: c.billedSeconds,
      rewrite,
      reason: c.reason,
      estimatedUsd: rewrite ? usd(c.billedSeconds) : 0,
      engineModel: ctx.engine.model,
      usdPerSecond: ctx.engine.usdPerSecond,
      joinFromIndex: c.plan.joinFromIndex,
    };
  });
  const scenes: McTalkQuote['scenes'] = planned.flatMap((c) =>
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
        estimatedUsd: chunk.rewrite ? usd(share) : 0,
      };
    }),
  );
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
