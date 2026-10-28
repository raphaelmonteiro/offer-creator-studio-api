import { EntityManager, In } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { McTalkChunkReason } from '../domain/mc-quality';
import { effectiveScenePrompts } from '../domain/mc-script-v2';
import { McSceneStatus } from '../domain/mc-state-machines';
import { buildChunkTalkStep, ChunkStepOutput } from '../domain/mc-talk-chunk-step';
import { planTalkChunks, TalkChunkPlan } from '../domain/mc-talk-chunks';
import { isTalkContinuousFormat, talkChunkMaxS } from '../domain/mc-talk-continuous.config';
import { McScript, McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import type { McMaterializerService } from './mc-materializer.service';
import { ChunkDraft, classifyChunk, recordedAudioHistory } from './mc-talk-chunk-classify';

/**
 * Plano do `talk` por TRECHO (change video-fala-continua, D4/D6/D7/D10/D13): função pura de (roteiro,
 * durações medidas dos TTS, motor, flag), recalculada a cada uso, sem coluna. Recebe o
 * `McMaterializerService` (createStep, cache e tentativas ficam lá).
 */

/** Projeto em modo contínuo (congelado no roteiro, D2). */
export function isContinuousProject(
  project: Pick<McProject, 'format'>,
  script: McScript | null | undefined,
): boolean {
  return script?.talkMode === 'continuous' && isTalkContinuousFormat(project.format);
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

type TalkContext = Awaited<ReturnType<McMaterializerService['talkProductionContext']>>;

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

/** Hash que o trecho seguinte encadeia: o do step corrente do trecho (se existe e está fora do escopo) ou o recalculado. */
async function previousHash(manager: EntityManager, prev: PlannedChunk): Promise<string> {
  if (prev.inScope) return prev.output.inputHash;
  const existing = await latestTalkStep(manager, prev.leader.id);
  return existing?.inputHash ?? prev.output.inputHash;
}

/** Tudo o que o plano de cada trecho consulta, calculado uma vez por rodada. */
interface PlanRun {
  mat: McMaterializerService;
  manager: EntityManager;
  args: ChunkPlanArgs;
  ctx: TalkContext;
  chunkCount: number;
  rowsById: Map<string, McScene>;
  history: Map<string, Set<string>>;
  targets: Set<string>;
  /** Índice do primeiro trecho que contém uma cena pedida (`-1` se nenhum; `0` sem escopo). */
  firstTarget: number;
}

/** Trechos do roteiro (limite do motor e do teto configurado); lança se alguma fala passa do limite. */
async function planTalkRows(
  manager: EntityManager,
  ctx: TalkContext,
  rows: McScene[],
): Promise<TalkChunkPlan[]> {
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
  return chunks;
}

/** Step do trecho para uma tentativa (a junção e o motion vêm do roteiro). */
function chunkStepBuilder(
  run: PlanRun,
  plan: TalkChunkPlan,
  scenes: McScene[],
  join: { fromStepHash: string; fromSceneRowId: string } | null,
): (attempt: number) => ChunkStepOutput {
  const scriptScene = run.args.script.scenes.find((s) => s.sceneId === scenes[0].scriptSceneId);
  const prompts = scriptScene ? effectiveScenePrompts(scriptScene) : null;
  return (attempt) =>
    buildChunkTalkStep({
      ctx: run.ctx,
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
      count: run.chunkCount,
    });
}

/**
 * Tentativa, step e cache do trecho. Trecho regravado só pela junção (cascata) ou por fala editada: o hash
 * mudou, mas a tentativa corrente continua sendo a do step antigo. Dois `talk` da mesma líder com a mesma
 * tentativa deixam o agendador escolher um deles pela ordem física das linhas — às vezes o antigo, já
 * concluído, e o novo nunca sai de `pending` (projeto preso em `generating`). Um step novo sempre abre
 * tentativa nova.
 */
async function resolveChunkAttempt(
  run: PlanRun,
  input: {
    leader: McScene;
    build: (attempt: number) => ChunkStepOutput;
    inScope: boolean;
    rerollTarget: boolean;
  },
): Promise<Pick<PlannedChunk, 'attempt' | 'output' | 'cached'>> {
  const { mat, manager, args } = run;
  const { leader, build, rerollTarget } = input;
  const cacheOf = (output: ChunkStepOutput) =>
    mat.findCachedOutput(manager, args.project.userId, McStepType.TALK, output.inputHash);
  let attempt = rerollTarget
    ? await mat.nextAttemptFor(manager, leader, McStepType.TALK)
    : await mat.currentOrFirstAttemptFor(manager, leader, McStepType.TALK);
  let output = build(attempt);
  let cached = rerollTarget ? null : await cacheOf(output);
  if (
    input.inScope &&
    !cached &&
    (await mat.talkAttemptHeldByOtherHash(manager, leader, attempt, output.inputHash))
  ) {
    attempt += 1;
    output = build(attempt);
    cached = await cacheOf(output);
  }
  return { attempt, output, cached };
}

/** Plano de um trecho: junção com o anterior, tentativa, cache e motivo. */
async function planOneChunk(
  run: PlanRun,
  plan: TalkChunkPlan,
  prev: PlannedChunk | undefined,
): Promise<PlannedChunk> {
  const { manager, args, targets } = run;
  const scenes = plan.sceneIds.map((id) => run.rowsById.get(id) as McScene);
  const leader = scenes[0];
  const inScope = !args.scope || (run.firstTarget >= 0 && plan.index >= run.firstTarget);
  const isTarget = !!args.scope && plan.sceneIds.some((id) => targets.has(id));
  const rerollTarget = isTarget && args.scope?.forceNewAttempt === true;
  const join = prev
    ? { fromStepHash: await previousHash(manager, prev), fromSceneRowId: prev.leader.id }
    : null;
  const build = chunkStepBuilder(run, plan, scenes, join);
  const resolved = await resolveChunkAttempt(run, { leader, build, inScope, rerollTarget });
  const draft: ChunkDraft = {
    plan,
    scenes,
    leader,
    ...resolved,
    inScope,
    billedSeconds: Number((plan.sentMs / 1000).toFixed(3)),
  };
  const { reason, chargedScenes } = classifyChunk({
    draft,
    history: run.history,
    rerollTarget,
    targetScenes: scenes.filter((s) => targets.has(s.id)),
  });
  return { ...draft, reason, chargedScenes };
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
  const chunks = await planTalkRows(manager, ctx, rows);
  const targets = new Set(args.scope?.targetRowIds ?? []);
  const run: PlanRun = {
    mat,
    manager,
    args,
    ctx,
    chunkCount: chunks.length,
    rowsById: new Map(rows.map((r) => [r.id, r])),
    history: await recordedAudioHistory(manager, project.id),
    targets,
    firstTarget: args.scope ? chunks.findIndex((c) => c.sceneIds.some((id) => targets.has(id))) : 0,
  };
  const planned: PlannedChunk[] = [];
  for (const plan of chunks) {
    planned.push(await planOneChunk(run, plan, planned[plan.index - 1]));
  }
  return planned;
}
