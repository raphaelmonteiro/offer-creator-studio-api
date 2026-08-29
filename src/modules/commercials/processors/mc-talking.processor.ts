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
import { buildActionVideoPrompt } from '../domain/mc-scene-prompts';
import { assertStepTransition, McStepStatus } from '../domain/mc-state-machines';
import { McStepType, sceneActionPromptEn } from '../domain/mc-types';
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
    const step = await this.pipeline.claimStep(stepId, [McStepType.LIPSYNC, McStepType.VIDEO]);
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
      const submit =
        this.provider() === 'mock'
          ? await this.mockSubmit(step, scene)
          : step.type === McStepType.LIPSYNC
            ? await this.submitKlingAvatar(scene)
            : await this.submitKlingAction(scene, project);

      await this.dataSource.transaction(async (manager) => {
        assertStepTransition(McStepStatus.RUNNING, McStepStatus.PROVIDER_WAIT);
        const won = await this.transitions.casTransition(
          manager,
          McStep,
          step.id,
          McStepStatus.RUNNING,
          McStepStatus.PROVIDER_WAIT,
          { provider: submit.provider, providerJobId: submit.providerJobId },
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

  private async submitKlingAvatar(scene: McScene): Promise<{
    provider: string;
    providerJobId: string;
    statusUrl: string;
    responseUrl: string;
  }> {
    const image = await this.loadAssetBuffer(scene.keyframeAssetId, 'keyframe');
    const audio = await this.loadAssetBuffer(scene.audioAssetId, 'áudio');
    if (audio.length > MC_DATA_URI_MAX_BYTES) {
      throw new TerminalProviderError(
        'Áudio da fala excede o teto de 3,3MB do data URI',
        'audio_too_large',
      );
    }
    const safeImage = await ensureImageUnderCap(image);
    const result = await this.fal.submit(KLING_AVATAR_MODEL, {
      image_url: toDataUri(safeImage, sniffImageMime(safeImage)),
      audio_url: toDataUri(audio, 'audio/mpeg'),
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
  ): Promise<{
    provider: string;
    providerJobId: string;
    statusUrl: string;
    responseUrl: string;
  }> {
    const image = await this.loadAssetBuffer(scene.keyframeAssetId, 'keyframe');
    const safeImage = await ensureImageUnderCap(image);
    const scriptScene = project.script?.scenes?.find((s) => s.idx === scene.idx);
    // O roteiro carrega a versão EN da ação (McScript v2); a cena guarda só a
    // pt (é o que a UI edita) — sem o roteiro, cai no prompt da cena.
    const actionEn = scriptScene
      ? sceneActionPromptEn(scriptScene)
      : sceneActionPromptEn({ actionPrompt: scene.actionPrompt });
    const result = await this.fal.submit(KLING_ACTION_MODEL, {
      prompt: buildActionVideoPrompt(actionEn),
      negative_prompt: KLING_ACTION_NEGATIVE_PROMPT,
      image_url: toDataUri(safeImage, sniffImageMime(safeImage)),
      duration: klingActionDuration(scene.durationS),
    });
    return {
      provider: KLING_ACTION_MODEL,
      providerJobId: result.requestId,
      statusUrl: result.statusUrl,
      responseUrl: result.responseUrl,
    };
  }

  /** Clipe sintético (cor + áudio muxado quando houver) em mock-jobs/{jobId}.mp4 — custo zero. */
  private async mockSubmit(
    step: McStep,
    scene: McScene,
  ): Promise<{ provider: string; providerJobId: string; statusUrl: string; responseUrl: string }> {
    const jobId = randomUUID();
    const spoken = step.type === McStepType.LIPSYNC;
    let audioPath: string | null = null;
    let durationS = Math.min(15, Math.max(2, scene.durationS || 5));
    if (spoken) {
      const audio = await this.loadAssetBuffer(scene.audioAssetId, 'áudio');
      const dir = await this.ffmpeg.createTempDir('mc-talking-mock-');
      audioPath = path.join(dir, 'voice.mp3');
      await fs.writeFile(audioPath, audio);
      const probe = await this.ffmpeg.probe(audioPath).catch(() => null);
      if (probe?.durationMs) durationS = Math.max(1, Math.round(probe.durationMs / 1000));
    }

    await fs.mkdir(this.storage.mockJobsAbsDir(), { recursive: true });
    const outPath = this.storage.mockJobAbsPath(jobId);
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    args.push('-f', 'lavfi', '-i', `color=c=0x2E5E9E:s=720x1280:r=30:d=${durationS}`);
    if (audioPath)
      args.push('-i', audioPath, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-shortest');
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
