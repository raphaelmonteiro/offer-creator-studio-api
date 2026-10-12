import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { FalQueueClient } from '../../../shared/providers/fal-queue.client';
import { sniffImageMime } from '../../../shared/providers/gemini-image.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import {
  klingActionDuration,
  KLING_ACTION_MODEL,
  KLING_ACTION_NEGATIVE_PROMPT,
  KLING_AVATAR_MODEL,
  MC_DATA_URI_MAX_BYTES,
  MC_FIRST_POLL_DELAY_S,
  mcExpireForQueue,
} from '../domain/mc-pipeline.config';
import { buildActionVideoPrompt, buildAvatarVideoPrompt } from '../domain/mc-scene-prompts';
import { assertStepTransition, McStepStatus } from '../domain/mc-state-machines';
import {
  buildTalkSubmitInput,
  isTalkEngineAvailabilityError,
  McTalkEffectiveEngine,
  McTalkEngineSnapshot,
  resolveTalkEngine,
  talkEngineSnapshot,
  talkFallbackEngine,
} from '../domain/mc-talk-engines';
import { buildTalkPrompt } from '../domain/mc-talk-prompts';
import { McStepType, sceneActionPromptEn } from '../domain/mc-types';
import { McKitIdentityMode } from '../domain/mc-kit-identity';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';

/** Escadas de re-encode até caber no teto de data URI (largura × qualidade JPEG). */
const IMAGE_SHRINK_LADDER: ReadonlyArray<{ width: number; quality: number }> = [
  { width: 1080, quality: 82 },
  { width: 900, quality: 75 },
  { width: 720, quality: 68 },
];

/**
 * Garante binário ≤ teto de data URI do fal (lição do PoC: ~3,3MB): imagem
 * maior é re-encodada/redimensionada com sharp em degraus; se nem o menor
 * degrau couber, erro de VALIDAÇÃO terminal (nunca mandar payload que o
 * provider vai rejeitar depois de cobrar). Exportada para o spec.
 */
export async function ensureImageUnderCap(
  buffer: Buffer,
  cap: number = MC_DATA_URI_MAX_BYTES,
): Promise<Buffer> {
  if (buffer.length <= cap) return buffer;
  for (const rung of IMAGE_SHRINK_LADDER) {
    const resized = await sharp(buffer)
      .resize({ width: rung.width, withoutEnlargement: true })
      .jpeg({ quality: rung.quality })
      .toBuffer();
    if (resized.length <= cap) return resized;
  }
  throw new TerminalProviderError(
    `Keyframe excede o teto de ${Math.round(cap / 1024 / 1024)}MB mesmo após re-encode`,
    'image_too_large',
  );
}

export function toDataUri(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/** Cor de fundo quando nem o projeto nem o kit definem uma (branco neutro). */
export const MC_TALK_DEFAULT_BACKGROUND = '#FFFFFF';

const HEX_COLOR = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;

/** #RRGGBB(AA) válido → normalizado em maiúsculas; qualquer outra coisa → null. */
export function normalizeHexColor(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return HEX_COLOR.test(text) ? text.toUpperCase() : null;
}

/**
 * Tile de FALA (D1): o tile do kit (recorte com alfa) com o fundo liso
 * recolorido para a cor da janela/preset — `flatten` do alfa sobre a cor, PNG
 * sem transparência. Recolorir não é regeração: a identidade é a mesma, só a
 * cor atrás muda (e ela entra no hash do step).
 */
export async function recolorTileBackground(buffer: Buffer, hex: string): Promise<Buffer> {
  const color = normalizeHexColor(hex) ?? MC_TALK_DEFAULT_BACKGROUND;
  return sharp(buffer).flatten({ background: color }).png().toBuffer();
}

/** Sobra do clipe `talk` mock sobre o áudio medido (s) — o ingest apara (D7: `trim`). */
export const MC_MOCK_TALK_MARGIN_S = 0.1;

/**
 * Duração (s, fracionária — o `d=` do lavfi aceita decimais) do clipe `talk`
 * mock: áudio MEDIDO + margem, com piso de 1 s. Nunca arredonda para inteiro:
 * arredondar para baixo deixaria o clipe mais curto que o áudio (boca parada
 * falsa); para cima, o ingest conforma do mesmo jeito que um clipe real.
 */
export function mockTalkClipDurationS(audioDurationMs: number): number {
  return Math.max(1, Number((audioDurationMs / 1000 + MC_MOCK_TALK_MARGIN_S).toFixed(3)));
}

/**
 * Consumer da fila mc.submit (conc. 8, plano §6.4) — os DOIS submits de vídeo:
 * `lipsync` (cena falada) e `video` (cena muda).
 *
 * DECISÃO (v1-B1): o motor de ação entrou AQUI em vez de num
 * `mc-video.processor` novo. A fila mc.submit tem um único consumer e os dois
 * caminhos compartilham tudo que é caro de duplicar — claim, teto de data URI,
 * consumo no submit, agendamento do poll com a tentativa na singletonKey e a
 * recuperação de submit órfão. Um processor novo só duplicaria esse arcabouço
 * e exigiria um dispatcher por tipo na fila. O nome do arquivo ficou por
 * compatibilidade de histórico; a classe trata "submits de vídeo".
 *
 * - lipsync REAL: Kling AI Avatar v2 via FalQueueClient (motor audio-driven
 *   decidido no PoC, plano §5.3) com `{ image_url, audio_url }` como data URIs
 *   (teto ~3,3MB de binário cada — imagem re-encodada se preciso).
 * - video REAL: Kling v3 standard i2v com `{ prompt EN + preservação,
 *   negative_prompt do PoC, image_url = keyframe, duration '5'|'10' }`.
 * - Ambos: gravam providerJobId + CAS running→provider_wait, CONSOMEM o custo
 *   NO SUBMIT (API assíncrona cara, §6.7) e agendam mc.poll (startAfter 15s,
 *   singletonKey `poll:{stepId}:{attempt}` — a chave DEVE incluir a tentativa,
 *   lição do processor de animações).
 * - MC_PIPELINE_PROVIDER=mock: clipe mp4 sintético via FfmpegRunner (cor +
 *   duração do áudio, com o áudio muxado) gravado em mock-jobs/ — o poll/
 *   ingest reais rodam por cima dele sem custo.
 *
 * Idempotência: submit que re-entra e encontra providerJobId gravado vira
 * poll (plano §6.4) — nunca submete duas vezes.
 */
@Injectable()
export class McTalkingProcessor {
  private readonly logger = new Logger(McTalkingProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly transitions: TaskTransitionService,
    private readonly commercials: CommercialsService,
    private readonly queue: AnimationQueueService,
    private readonly fal: FalQueueClient,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
  ) {}

  private provider(): string {
    return process.env.MC_PIPELINE_PROVIDER || 'mock';
  }

  async process({ stepId }: { stepId: string; projectId?: string }): Promise<void> {
    const step = await this.pipeline.claimStep(stepId, [
      McStepType.LIPSYNC,
      McStepType.VIDEO,
      McStepType.TALK,
    ]);
    if (!step) {
      await this.recoverOrphanSubmit(stepId);
      return;
    }
    if (!step.sceneId) return;

    const scene = await this.dataSource.getRepository(McScene).findOneBy({ id: step.sceneId });
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!scene || !project) return;

    try {
      // Pipeline v2 (ADR §4.1): revalida a autorização da revisão IMEDIATAMENTE
      // antes do submit pago — aprovação caída entre o claim e aqui cancela o
      // step sem enviar nada ao provider.
      if (!(await this.pipeline.assertSubmitAllowed(step))) return;
      const submit: {
        provider: string;
        providerJobId: string;
        statusUrl: string;
        responseUrl: string;
        inputSnapshot?: Record<string, unknown>;
      } =
        this.provider() === 'mock'
          ? await this.mockSubmit(step, scene)
          : step.type === McStepType.LIPSYNC
            ? await this.submitKlingAvatar(scene, step)
            : step.type === McStepType.TALK
              ? await this.submitTalk(scene, project, step)
              : await this.submitKlingAction(scene, project, step);

      await this.dataSource.transaction(async (manager) => {
        assertStepTransition(McStepStatus.RUNNING, McStepStatus.PROVIDER_WAIT);
        const won = await this.transitions.casTransition(
          manager,
          McStep,
          step.id,
          McStepStatus.RUNNING,
          McStepStatus.PROVIDER_WAIT,
          {
            provider: submit.provider,
            providerJobId: submit.providerJobId,
            // talk (D2): o motor EFETIVO fica no snapshot do step (fallback registrado)
            ...(submit.inputSnapshot ? { inputSnapshot: submit.inputSnapshot } : {}),
          },
        );
        if (!won) return;
        await this.commercials.appendEvent(manager, {
          userId: project.userId,
          refKind: 'step',
          refId: step.id,
          kind: 'transition',
          fromStatus: McStepStatus.RUNNING,
          toStatus: McStepStatus.PROVIDER_WAIT,
          detail: {
            type: step.type,
            provider: submit.provider,
            providerJobId: submit.providerJobId,
          },
        });
        // CONSUMO no submit (plano §6.7): API assíncrona cara. O marcador de
        // "consumiu" é o próprio providerJobId gravado (base do estorno).
        await this.pipeline.consumeStepCredits(manager, project.id, step);
        await this.pipeline.notifyStep(manager, project.userId, step, McStepStatus.PROVIDER_WAIT);
        await this.queue.publish(
          QUEUES.MC_POLL,
          {
            stepId: step.id,
            attempt: 1,
            statusUrl: submit.statusUrl,
            responseUrl: submit.responseUrl,
          },
          {
            startAfterSeconds: MC_FIRST_POLL_DELAY_S,
            singletonKey: `poll:${step.id}:1`, // a tentativa NA CHAVE (ver doc da classe)
            expireInSeconds: mcExpireForQueue(QUEUES.MC_POLL),
          },
        );
      });
    } catch (err) {
      this.logger.error(`Submit ${stepId} (${step.type}) falhou: ${(err as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.RUNNING, err, {
        fallbackCode: 'submit_failed',
      });
    }
  }

  // ─────────────────────────────── submits ───────────────────────────────

  private async submitKlingAvatar(
    scene: McScene,
    step?: McStep,
  ): Promise<{
    provider: string;
    providerJobId: string;
    statusUrl: string;
    responseUrl: string;
  }> {
    // v2: os assets vêm do SNAPSHOT imutável do step (o que a aprovação assinou),
    // não do atalho corrente da cena.
    const snapshot = (step?.inputSnapshot ?? null) as {
      keyframeAssetId?: string;
      audioAssetId?: string;
      motion?: string;
    } | null;
    const image = await this.loadAssetBuffer(
      snapshot?.keyframeAssetId ?? scene.keyframeAssetId,
      'keyframe',
    );
    const audio = await this.loadAssetBuffer(snapshot?.audioAssetId ?? scene.audioAssetId, 'áudio');
    if (audio.length > MC_DATA_URI_MAX_BYTES) {
      throw new TerminalProviderError(
        'Áudio da fala excede o teto de 3,3MB do data URI',
        'audio_too_large',
      );
    }
    const safeImage = await ensureImageUnderCap(image);
    // v2: o MOVIMENTO da cena vai como prompt do Avatar (ação simples + boca
    // sincronizada — validado em uso real 18/09). Legado (sem snapshot) segue
    // sem prompt, preservando o executor antigo.
    const motion = snapshot?.motion?.trim();
    const result = await this.fal.submit(KLING_AVATAR_MODEL, {
      image_url: toDataUri(safeImage, sniffImageMime(safeImage)),
      audio_url: toDataUri(audio, 'audio/mpeg'),
      ...(motion ? { prompt: buildAvatarVideoPrompt(motion) } : {}),
    });
    return {
      provider: KLING_AVATAR_MODEL,
      providerJobId: result.requestId,
      statusUrl: result.statusUrl,
      responseUrl: result.responseUrl,
    };
  }

  /**
   * MOTOR DE AÇÃO (v1-B1) — cena SEM fala no Kling v3 standard i2v via fal
   * (decisão do PoC, plano changelog v1.3). Input: prompt em INGLÊS da cena +
   * sufixo curto de preservação de identidade/estilo (mesmo padrão do
   * keyframe), o negative_prompt padrão do PoC, o KEYFRAME da cena como
   * `image_url` (data URI com o mesmo teto de ~3,3MB do Avatar) e `duration`
   * '5' ou '10' — a mais próxima da duração da cena.
   *
   * O poll/ingest a jusante são os MESMOS do lipsync (asset kind `scene_clip`
   * quando o step é `video`); o scheduler já sabe que a cena muda finaliza no
   * `video`, então nada muda na topologia.
   */
  private async submitKlingAction(
    scene: McScene,
    project: McProject,
    step?: McStep,
  ): Promise<{
    provider: string;
    providerJobId: string;
    statusUrl: string;
    responseUrl: string;
  }> {
    const snapshot = (step?.inputSnapshot ?? null) as {
      keyframeAssetId?: string;
      motion?: string;
      providerDuration?: string;
    } | null;
    const image = await this.loadAssetBuffer(
      snapshot?.keyframeAssetId ?? scene.keyframeAssetId,
      'keyframe',
    );
    const safeImage = await ensureImageUnderCap(image);
    let actionEn: string;
    if (snapshot?.motion) {
      // v2 (ADR §3.2): o MOVIMENTO efetivo (derivação válida da intenção pt
      // corrente) vem do snapshot do step — nunca uma EN antiga por posição.
      actionEn = snapshot.motion;
    } else {
      const scriptScene = project.script?.scenes?.find((s) => s.idx === scene.idx);
      // O roteiro carrega a versão EN da ação (McScript v2); a cena guarda só a
      // pt (é o que a UI edita) — sem o roteiro, cai no prompt da cena.
      actionEn = scriptScene
        ? sceneActionPromptEn(scriptScene)
        : sceneActionPromptEn({ actionPrompt: scene.actionPrompt });
    }
    const result = await this.fal.submit(KLING_ACTION_MODEL, {
      prompt: buildActionVideoPrompt(actionEn),
      negative_prompt: KLING_ACTION_NEGATIVE_PROMPT,
      image_url: toDataUri(safeImage, sniffImageMime(safeImage)),
      duration:
        (snapshot?.providerDuration as '5' | '10' | undefined) ??
        klingActionDuration(scene.durationS),
    });
    return {
      provider: KLING_ACTION_MODEL,
      providerJobId: result.requestId,
      statusUrl: result.statusUrl,
      responseUrl: result.responseUrl,
    };
  }

  /**
   * STEP `talk` (change video-formatos-personagem, D1/D2/D7): clipe falado a
   * partir do TILE do kit. Entrada do motor = tile de fala (tile recolorido
   * para a cor da janela) + áudio da cena + prompt curto (pose neutra no
   * início/fim, sem texto). NUNCA vai arte de fundo, preço, nome ou logo.
   *
   * Motor: `talkEngineFor({tier, identityMode})` — `logo_as_is` usa o motor de
   * logo em qualquer tier; os demais, o do tier. Fallback para o motor do tier
   * SÓ em erro de disponibilidade do motor de logo (nunca por reprovação de
   * inspeção), com o motor efetivo gravado no snapshot do step.
   */
  private async submitTalk(
    scene: McScene,
    project: McProject,
    step: McStep,
  ): Promise<{
    provider: string;
    providerJobId: string;
    statusUrl: string;
    responseUrl: string;
    inputSnapshot: Record<string, unknown>;
  }> {
    const snapshot = (step.inputSnapshot ?? {}) as {
      tileAssetId?: string | null;
      audioAssetId?: string | null;
      backgroundColor?: string | null;
      motion?: string | null;
      prompt?: string | null;
      engine?: McTalkEngineSnapshot | null;
      tier?: string | null;
      identityMode?: McKitIdentityMode | null;
    };
    const kit = await this.dataSource
      .getRepository(McCharacterKit)
      .findOneBy({ id: project.kitId });
    const tileAssetId = snapshot.tileAssetId ?? kit?.tileAssetId ?? null;
    const tile = await this.loadAssetBuffer(tileAssetId, 'tile de fala');
    const audio = await this.loadAssetBuffer(snapshot.audioAssetId ?? scene.audioAssetId, 'áudio');
    if (audio.length > MC_DATA_URI_MAX_BYTES) {
      throw new TerminalProviderError(
        'Áudio da fala excede o teto de 3,3MB do data URI',
        'audio_too_large',
      );
    }
    const backgroundColor =
      normalizeHexColor(snapshot.backgroundColor) ??
      normalizeHexColor(kit?.tileBackgroundColor) ??
      MC_TALK_DEFAULT_BACKGROUND;
    const speakingTile = await ensureImageUnderCap(
      await recolorTileBackground(tile, backgroundColor),
    );
    const prompt = snapshot.prompt?.trim() || buildTalkPrompt(snapshot.motion);
    const tier = (snapshot.tier ?? project.tier ?? 'economico') as 'economico' | 'premium';
    const identityMode = snapshot.identityMode ?? kit?.identityMode ?? 'generated';
    // Motor ESCOLHIDO: o do snapshot (o hash assinou aquele modelo; completado
    // pela config se veio parcial) ou a regra D2. Nunca o `effectiveEngine` de
    // uma execução anterior — cada execução tenta o motor planejado de novo.
    const chosen = resolveTalkEngine(snapshot.engine, { tier, identityMode });
    const ingredients = {
      imageUrl: toDataUri(speakingTile, sniffImageMime(speakingTile)),
      audioUrl: toDataUri(audio, 'audio/mpeg'),
      prompt,
    };
    let effective: McTalkEffectiveEngine | null = null;
    let result: Awaited<ReturnType<FalQueueClient['submit']>>;
    try {
      result = await this.fal.submit(chosen.model, buildTalkSubmitInput(chosen.model, ingredients));
    } catch (err) {
      const fallback = talkFallbackEngine(chosen, tier);
      if (!fallback || !isTalkEngineAvailabilityError(err)) throw err;
      this.logger.warn(
        `Motor ${chosen.model} indisponível (${(err as Error).message}) — ` +
          `fallback para o motor do tier (${fallback.model})`,
      );
      result = await this.fal.submit(
        fallback.model,
        buildTalkSubmitInput(fallback.model, ingredients),
      );
      effective = fallback;
    }
    // `engine` = planejado, `effectiveEngine` = submetido (com `fallbackFrom`
    // só quando houve fallback) — o ingest lê o efetivo para motor/tarifa.
    const engines = talkEngineSnapshot(chosen, effective);
    return {
      provider: engines.effectiveEngine.model,
      providerJobId: result.requestId,
      statusUrl: result.statusUrl,
      responseUrl: result.responseUrl,
      inputSnapshot: {
        ...(step.inputSnapshot ?? {}),
        tileAssetId,
        backgroundColor,
        prompt,
        tier,
        identityMode,
        ...engines,
      },
    };
  }

  /**
   * Clipe sintético (cor + áudio muxado quando houver) em mock-jobs/{jobId}.mp4 — custo zero.
   *
   * talk (D7): a duração do clipe é a do ÁUDIO MEDIDO mais `MC_MOCK_TALK_MARGIN_S`,
   * sem `-shortest` (nunca, D7) — o ingest conforma esse clipe exatamente como
   * conformaria um clipe real (aparar os 100 ms de sobra). O lipsync legado
   * segue com segundos inteiros + `-shortest` (executor antigo preservado).
   */
  private async mockSubmit(
    step: McStep,
    scene: McScene,
  ): Promise<{ provider: string; providerJobId: string; statusUrl: string; responseUrl: string }> {
    const jobId = randomUUID();
    const talk = step.type === McStepType.TALK;
    const spoken = step.type === McStepType.LIPSYNC || talk;
    const snapshot = (step.inputSnapshot ?? null) as {
      audioAssetId?: string;
      providerDuration?: string;
    } | null;
    let audioPath: string | null = null;
    let durationS = Math.min(15, Math.max(2, scene.durationS || 5));
    // v2: o clipe de ação mock tem a duração que o PROVIDER entregaria (5/10s),
    // para que scene_compose e a validação de locução vejam números reais.
    if (!spoken && snapshot?.providerDuration) durationS = Number(snapshot.providerDuration);
    if (spoken) {
      const audio = await this.loadAssetBuffer(
        snapshot?.audioAssetId ?? scene.audioAssetId,
        'áudio',
      );
      const dir = await this.ffmpeg.createTempDir('mc-talking-mock-');
      audioPath = path.join(dir, 'voice.mp3');
      await fs.writeFile(audioPath, audio);
      const probe = await this.ffmpeg.probe(audioPath).catch(() => null);
      if (probe?.durationMs) {
        durationS = talk
          ? mockTalkClipDurationS(probe.durationMs)
          : Math.max(1, Math.round(probe.durationMs / 1000));
      }
    }

    await fs.mkdir(this.storage.mockJobsAbsDir(), { recursive: true });
    const outPath = this.storage.mockJobAbsPath(jobId);
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    // talk: tile 3:4 (proporção típica do tile do kit); demais: 9:16 da cena
    const size = talk ? '720x960' : '720x1280';
    args.push('-f', 'lavfi', '-i', `color=c=0x2E5E9E:s=${size}:r=30:d=${durationS}`);
    if (audioPath) {
      args.push('-i', audioPath, '-map', '0:v', '-map', '1:a', '-c:a', 'aac');
      if (!talk) args.push('-shortest');
    }
    // -f mp4 explícito: o sufixo .part (escrita atômica) impede o ffmpeg de
    // inferir o muxer pela extensão.
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4', `${outPath}.part`);
    try {
      await this.ffmpeg.run(args, { durationMs: durationS * 1000, timeoutMs: 90_000 });
      await this.ffmpeg.finalizeOutput(`${outPath}.part`, outPath);
    } finally {
      if (audioPath) await this.ffmpeg.removeTempDir(path.dirname(audioPath));
    }
    return {
      provider: 'mock',
      providerJobId: jobId,
      statusUrl: `mock:${jobId}`,
      responseUrl: `mock:${jobId}`,
    };
  }

  // ─────────────────────────────── suporte ───────────────────────────────

  /** Re-entrada de job com o step já em running E providerJobId gravado: submit vira poll (§6.4). */
  private async recoverOrphanSubmit(stepId: string): Promise<void> {
    const fresh = await this.dataSource.getRepository(McStep).findOneBy({ id: stepId });
    if (!fresh || fresh.status !== McStepStatus.RUNNING || !fresh.providerJobId) return;
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McStep,
        stepId,
        McStepStatus.RUNNING,
        McStepStatus.PROVIDER_WAIT,
      );
      if (!won) return;
      const project = await manager.findOneByOrFail(McProject, { id: fresh.projectId });
      await this.commercials.appendEvent(manager, {
        userId: project.userId,
        refKind: 'step',
        refId: stepId,
        kind: 'submit_recovered_as_poll',
        fromStatus: McStepStatus.RUNNING,
        toStatus: McStepStatus.PROVIDER_WAIT,
        detail: { providerJobId: fresh.providerJobId },
      });
      await this.queue.publish(
        QUEUES.MC_POLL,
        { stepId, attempt: 1 },
        {
          startAfterSeconds: MC_FIRST_POLL_DELAY_S,
          singletonKey: `poll:${stepId}:r${Date.now()}`,
          expireInSeconds: mcExpireForQueue(QUEUES.MC_POLL),
        },
      );
    });
  }

  private async loadAssetBuffer(assetId: string | null, label: string): Promise<Buffer> {
    if (!assetId) {
      throw new TerminalProviderError(
        `Cena sem ${label} pronto para o submit`,
        'missing_input_asset',
      );
    }
    const asset = await this.dataSource.getRepository(AnimationAsset).findOneBy({ id: assetId });
    if (!asset?.fileUrl) {
      throw new TerminalProviderError(`Asset de ${label} sem arquivo`, 'missing_input_asset');
    }
    const buffer = await this.storage.readUploadsFile(asset.fileUrl);
    if (!buffer) {
      throw new TerminalProviderError(
        `Arquivo de ${label} ausente no disco`,
        'missing_input_asset',
      );
    }
    return buffer;
  }
}
