import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AnimationTask } from '../entities/animation-task.entity';
import { AnimationAsset } from '../entities/animation-asset.entity';
import { TaskStatus } from '../domain/task-state-machine';
import { TaskTransitionService } from '../services/task-transition.service';
import { AnimationTasksService } from '../services/animation-tasks.service';
import { AnimationQueueService, QUEUES } from '../services/animation-queue.service';
import { RunwayProvider } from '../providers/runway.provider';
import { FalKlingProvider } from '../providers/fal-kling.provider';
import { ElevenLabsProvider } from '../providers/elevenlabs.provider';
import { HeyGenProvider } from '../providers/heygen.provider';
import { TerminalProviderError } from '../providers/provider.types';
import { OpenAiImageService } from '../../ai/openai-image.service';
import { OpenAiImageSize } from '../../ai/utils/ai-image.util';

const POLL_BACKOFF_S = [15, 30, 60];
const TASK_TIMEOUT_MS = 10 * 60 * 1000;
/** Runway aceita até 5MB de data URI; base64 infla ~33% sobre o binário. */
const MAX_INLINE_IMAGE_BYTES = 3.3 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function mimeForFile(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'image/png';
}

/** gen4_turbo só aceita esta lista fechada de ratios (não aceita '9:16' & cia). */
const RUNWAY_RATIO_BY_ASPECT: Record<string, string> = {
  '9:16': '720:1280',
  '16:9': '1280:720',
  '1:1': '960:960',
  '4:5': '832:1104',
};

/** gpt-image só gera nestes três tamanhos; escolhe o mais próximo do aspecto pedido. */
const OPENAI_SIZE_BY_ASPECT: Record<string, OpenAiImageSize> = {
  '9:16': '1024x1536',
  '4:5': '1024x1536',
  '1:1': '1024x1024',
  '16:9': '1536x1024',
};

/**
 * Consumers ai.generate / ai.poll (TDD §5): executa etapas do pipeline em
 * sequência. TTS é síncrono; vídeo é submit → provider_processing → poll
 * (webhook apenas antecipa o poll). Toda transição é CAS.
 */
@Injectable()
export class AiGenerationProcessor {
  private readonly logger = new Logger(AiGenerationProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly transitions: TaskTransitionService,
    private readonly tasksService: AnimationTasksService,
    private readonly queue: AnimationQueueService,
    private readonly runway: RunwayProvider,
    private readonly falKling: FalKlingProvider,
    private readonly elevenLabs: ElevenLabsProvider,
    private readonly heyGen: HeyGenProvider,
    private readonly openAiImage: OpenAiImageService,
  ) {}

  /** ai.generate: pega a task em queued e executa a próxima etapa pendente. */
  async generate({ taskId }: { taskId: string }): Promise<void> {
    const task = await this.dataSource.getRepository(AnimationTask).findOneBy({ id: taskId });
    if (!task) return;
    const won = await this.dataSource.transaction((m) =>
      this.transitions.transitionTask(m, taskId, TaskStatus.QUEUED, TaskStatus.PREPARING, {
        startedAt: task.startedAt ?? new Date(),
      }),
    );
    if (!won) return;
    await this.runNextStep(taskId);
  }

  /** ai.poll: consulta status do provider; re-agenda com backoff enquanto processa. */
  async poll({ taskId, attempt = 0 }: { taskId: string; attempt?: number }): Promise<void> {
    const task = await this.dataSource.getRepository(AnimationTask).findOneBy({ id: taskId });
    if (!task || task.status !== TaskStatus.PROVIDER_PROCESSING) return;

    if (task.startedAt && Date.now() - task.startedAt.getTime() > TASK_TIMEOUT_MS) {
      await this.dataSource.transaction((m) =>
        this.tasksService.failTask(
          m,
          taskId,
          TaskStatus.PROVIDER_PROCESSING,
          'provider_timeout',
          'Provider excedeu o tempo limite',
        ),
      );
      return;
    }

    const step = task.pipeline[task.currentStepIndex];
    try {
      const status = await this.providerFor(step.provider).getStatus(task.providerJobId as string);
      if (status.state === 'processing') {
        const delay = POLL_BACKOFF_S[Math.min(attempt, POLL_BACKOFF_S.length - 1)];
        // a chave inclui a tentativa: sem isso o singletonKey colide com ESTE
        // job (ainda `active`) e o pg-boss descarta o reagendamento em silêncio,
        // matando a cadeia de polling depois da primeira consulta.
        await this.queue.publish(
          QUEUES.AI_POLL,
          { taskId, attempt: attempt + 1 },
          { startAfterSeconds: delay, singletonKey: `poll:${taskId}:${attempt + 1}` },
        );
        return;
      }
      if (status.state === 'failed') {
        await this.dataSource.transaction((m) =>
          this.tasksService.failTask(
            m,
            taskId,
            TaskStatus.PROVIDER_PROCESSING,
            status.errorCode ?? 'provider_failed',
            status.errorMessage ?? 'Falha no provider',
          ),
        );
        return;
      }
      // succeeded → ingest
      const won = await this.dataSource.transaction((m) =>
        this.transitions.transitionTask(
          m,
          taskId,
          TaskStatus.PROVIDER_PROCESSING,
          TaskStatus.INGESTING,
        ),
      );
      if (!won) return;
      await this.ingestAndAdvance(taskId, status.outputUrl as string, status.costUsd);
    } catch (err) {
      if (err instanceof TerminalProviderError) {
        await this.dataSource.transaction((m) =>
          this.tasksService.failTask(
            m,
            taskId,
            TaskStatus.PROVIDER_PROCESSING,
            err.code,
            err.message,
          ),
        );
        return;
      }
      // transiente: re-agenda o poll (rede de segurança)
      await this.queue.publish(
        QUEUES.AI_POLL,
        { taskId, attempt: attempt + 1 },
        { startAfterSeconds: 30, singletonKey: `poll:${taskId}:${attempt + 1}` },
      );
    }
  }

  private async runNextStep(taskId: string): Promise<void> {
    const task = await this.dataSource.getRepository(AnimationTask).findOneByOrFail({ id: taskId });
    const stepIndex = task.pipeline.findIndex((s) => s.status === 'pending');
    if (stepIndex === -1) {
      await this.completeTask(taskId);
      return;
    }
    const step = task.pipeline[stepIndex];
    await this.dataSource
      .getRepository(AnimationTask)
      .update({ id: taskId }, { currentStepIndex: stepIndex });

    try {
      if (step.provider === 'elevenlabs') {
        await this.runTtsStep(taskId, stepIndex);
        await this.runNextStep(taskId); // TTS é síncrono — segue direto p/ próxima etapa
        return;
      }
      if (step.key === 'base_image') {
        await this.runBaseImageStep(taskId, stepIndex);
        await this.runNextStep(taskId); // geração de imagem é síncrona, igual ao TTS
        return;
      }
      const { providerJobId } = await this.submitVideoStep(task, stepIndex);
      const submitted = await this.dataSource.transaction(async (m) => {
        const a = await this.transitions.transitionTask(
          m,
          taskId,
          TaskStatus.PREPARING,
          TaskStatus.SUBMITTED,
          { provider: step.provider, providerJobId },
        );
        const b =
          a &&
          (await this.transitions.transitionTask(
            m,
            taskId,
            TaskStatus.SUBMITTED,
            TaskStatus.PROVIDER_PROCESSING,
          ));
        return a && b;
      });
      if (submitted) {
        await this.queue.publish(
          QUEUES.AI_POLL,
          { taskId },
          { startAfterSeconds: POLL_BACKOFF_S[0], singletonKey: `poll:${taskId}` },
        );
      }
    } catch (err) {
      const code = err instanceof TerminalProviderError ? err.code : 'provider_error';
      await this.dataSource.transaction((m) =>
        this.tasksService.failTask(m, taskId, TaskStatus.PREPARING, code, (err as Error).message),
      );
    }
  }

  /** TTS síncrono: gera (ou reusa cache), salva asset e marca a etapa consumida. */
  private async runTtsStep(taskId: string, stepIndex: number): Promise<void> {
    const task = await this.dataSource.getRepository(AnimationTask).findOneByOrFail({ id: taskId });
    const step = task.pipeline[stepIndex];
    const input = task.input as { speechText: string; voiceId: string };
    const audio = await this.elevenLabs.synthesize({
      text: input.speechText,
      voiceId: input.voiceId,
    });
    const fileUrl = await this.saveFile(task.userId, taskId, 'voice.mp3', audio);
    await this.dataSource.transaction(async (m) => {
      const asset = await m.getRepository(AnimationAsset).save({
        userId: task.userId,
        kind: 'audio' as const,
        status: 'ready' as const,
        name: `Voz — ${input.speechText.slice(0, 40)}`,
        origin: 'ai_generated' as const,
        sourceTaskId: taskId,
        fileUrl,
        mimeType: 'audio/mpeg',
        contentHash: (step as { contentHash?: string }).contentHash ?? null,
        metadata: { voiceId: input.voiceId },
      });
      await this.markStepDone(m, taskId, stepIndex, asset.id);
    });
  }

  /**
   * Gera a imagem base do background (gpt-image via OpenAiImageService) e salva
   * como asset. Síncrono, igual ao TTS — a etapa de vídeo seguinte consome esse
   * asset como `promptImage`.
   */
  private async runBaseImageStep(taskId: string, stepIndex: number): Promise<void> {
    const task = await this.dataSource.getRepository(AnimationTask).findOneByOrFail({ id: taskId });
    const step = task.pipeline[stepIndex];
    if (step.provider !== 'openai') {
      throw new TerminalProviderError(
        `Engine de imagem base não implementada: ${step.provider}`,
        'unsupported_base_image_engine',
      );
    }
    const input = task.input as { prompt?: string; styleHint?: string; aspectRatio?: string };
    const prompt = [input.prompt, input.styleHint].filter(Boolean).join('. ');
    const result = await this.openAiImage.generateImage({
      feature: 'animation_base_image',
      prompt,
      size: OPENAI_SIZE_BY_ASPECT[input.aspectRatio ?? '9:16'] ?? '1024x1536',
      assetKind: 'background',
    });
    const fileUrl = await this.saveFile(
      task.userId,
      taskId,
      `base${result.image.extension}`, // extension já vem com o ponto (".jpg")
      result.image.buffer,
    );
    await this.dataSource.transaction(async (m) => {
      const asset = await m.getRepository(AnimationAsset).save({
        userId: task.userId,
        kind: 'image' as const,
        status: 'ready' as const,
        name: `Imagem base — ${(input.prompt ?? '').slice(0, 40)}`,
        origin: 'ai_generated' as const,
        sourceTaskId: taskId,
        fileUrl,
        mimeType: result.image.mimeType,
        metadata: { prompt, model: result.model, size: result.size },
      });
      await this.markStepDone(m, taskId, stepIndex, asset.id);
    });
  }

  private async submitVideoStep(
    task: AnimationTask,
    stepIndex: number,
  ): Promise<{ providerJobId: string }> {
    const step = task.pipeline[stepIndex];
    const input = task.input as Record<string, unknown>;
    // BASE_URL inclui o prefixo /v1; os estáticos são servidos na raiz (/uploads/*).
    const baseUrl = this.config
      .get('BASE_URL', 'http://localhost:3001')
      .replace(/\/v1\/?$/, '');
    const imageUrl = await this.resolveImageUrl(task);
    if (step.provider === 'fal_kling') {
      return this.falKling.submitImageToVideo({
        imageUrl,
        motionPrompt: String(input.motion ?? input.prompt ?? 'subtle idle animation'),
        durationS: Number(input.durationS ?? 5),
      });
    }
    if (step.provider === 'heygen') {
      const ttsAsset = await this.findStepAsset(task, 'tts');
      return this.heyGen.submitTalkingPhoto({
        photoUrl: imageUrl,
        audioUrl: `${baseUrl}${ttsAsset?.fileUrl ?? ''}`,
      });
    }
    const aspectRatio = String(input.aspectRatio ?? '9:16');
    const ratio = RUNWAY_RATIO_BY_ASPECT[aspectRatio];
    if (!ratio) {
      throw new TerminalProviderError(
        `Aspecto sem equivalente no Runway: ${aspectRatio}`,
        'unsupported_aspect_ratio',
      );
    }
    return this.runway.submitImageToVideo({
      imageUrl,
      prompt: String(input.prompt ?? ''),
      durationS: Number(input.durationS ?? 5),
      ratio,
    });
  }

  /** Ingest (TDD §5.1 etapa 3): download do provider → uploads → asset ready → avança pipeline. */
  private async ingestAndAdvance(
    taskId: string,
    outputUrl: string,
    costUsd?: number,
  ): Promise<void> {
    const task = await this.dataSource.getRepository(AnimationTask).findOneByOrFail({ id: taskId });
    try {
      const response = await fetch(outputUrl);
      if (!response.ok) throw new Error(`Download falhou: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const fileUrl = await this.saveFile(task.userId, taskId, 'output.mp4', buffer);
      await this.dataSource.transaction(async (m) => {
        const asset = await m.getRepository(AnimationAsset).save({
          userId: task.userId,
          kind:
            task.type === 'background_video'
              ? ('background_video' as const)
              : ('mascot_video' as const),
          status: 'ready' as const,
          name: `${task.type} ${new Date().toISOString().slice(0, 16)}`,
          origin: 'ai_generated' as const,
          sourceTaskId: taskId,
          fileUrl,
          mimeType: 'video/mp4',
          fileSize: String(buffer.length),
          metadata: { provider: task.provider, input: task.input },
        });
        await this.markStepDone(m, taskId, task.currentStepIndex, asset.id);
        if (costUsd != null) {
          await m.update(AnimationTask, { id: taskId }, { providerCostUsd: String(costUsd) });
        }
      });
      const updated = await this.dataSource
        .getRepository(AnimationTask)
        .findOneByOrFail({ id: taskId });
      const hasNext = updated.pipeline.some((s) => s.status === 'pending');
      if (hasNext) {
        const won = await this.dataSource.transaction((m) =>
          this.transitions.transitionTask(m, taskId, TaskStatus.INGESTING, TaskStatus.PREPARING),
        );
        if (won) await this.runNextStep(taskId);
      } else {
        await this.completeTask(taskId);
      }
    } catch (err) {
      await this.dataSource.transaction((m) =>
        this.tasksService.failTask(
          m,
          taskId,
          TaskStatus.INGESTING,
          'ingest_failed',
          (err as Error).message,
        ),
      );
    }
  }

  private async completeTask(taskId: string): Promise<void> {
    const task = await this.dataSource.getRepository(AnimationTask).findOneByOrFail({ id: taskId });
    const lastAsset =
      [...task.pipeline].reverse().find((s) => s.resultAssetId)?.resultAssetId ?? null;
    await this.dataSource.transaction(async (m) => {
      const from = task.status === TaskStatus.INGESTING ? TaskStatus.INGESTING : task.status;
      if (from === TaskStatus.INGESTING) {
        await this.transitions.transitionTask(
          m,
          taskId,
          TaskStatus.INGESTING,
          TaskStatus.SUCCEEDED,
          { resultAssetId: lastAsset, finishedAt: new Date() },
        );
      } else if (from === TaskStatus.PREPARING) {
        // pipeline todo resolvido por cache — preparing → submitted → … não se aplica;
        // marca sucesso direto via failsafe (transição preparing→failed→retry não cabe aqui)
        await m.update(
          AnimationTask,
          { id: taskId, status: TaskStatus.PREPARING },
          { status: TaskStatus.SUCCEEDED, resultAssetId: lastAsset, finishedAt: new Date() },
        );
      }
    });
  }

  /** Marca etapa concluída e acumula consumo de créditos (TDD §3.4 regra 2). */
  private async markStepDone(
    manager: EntityManager,
    taskId: string,
    stepIndex: number,
    assetId: string,
  ): Promise<void> {
    const task = await manager.findOneByOrFail(AnimationTask, { id: taskId });
    const pipeline = task.pipeline.map((s, i) =>
      i === stepIndex ? { ...s, status: 'succeeded' as const, resultAssetId: assetId } : s,
    );
    await manager.update(
      AnimationTask,
      { id: taskId },
      {
        pipeline,
        consumedCredits: task.consumedCredits + (task.pipeline[stepIndex]?.costCredits ?? 0),
      },
    );
  }

  private async findStepAsset(task: AnimationTask, key: string): Promise<AnimationAsset | null> {
    const assetId = task.pipeline.find((s) => s.key === key)?.resultAssetId;
    if (!assetId) return null;
    return this.dataSource.getRepository(AnimationAsset).findOneBy({ id: assetId });
  }

  /**
   * Resolve a imagem de entrada dos providers de vídeo. Runway só aceita URL
   * https:// com domínio (não IP) e publicamente acessível, ou data URI — nossos
   * uploads não são nem uma coisa nem outra (http, e localhost/IP), então todo
   * arquivo local vira data URI. URL externa https:// passa direto.
   */
  private async resolveImageUrl(task: AnimationTask): Promise<string> {
    // a imagem base gerada na etapa anterior tem precedência sobre o input cru
    const baseImage = await this.findStepAsset(task, 'base_image');
    if (baseImage?.fileUrl) return this.toDataUri(baseImage.fileUrl);

    const input = task.input as Record<string, unknown>;
    const assetId = (input.sourceAssetId ?? input.referenceAssetId) as string | undefined;
    if (!assetId) {
      const raw = String(input.imageUrl ?? '');
      if (!raw) {
        throw new TerminalProviderError(
          'Etapa de vídeo sem imagem de origem (sourceAssetId/referenceAssetId/imageUrl)',
          'missing_source_image',
        );
      }
      return raw.startsWith('/uploads/') ? this.toDataUri(raw) : raw;
    }
    const asset = await this.dataSource
      .getRepository(AnimationAsset)
      .findOneByOrFail({ id: assetId });
    return this.toDataUri(asset.fileUrl);
  }

  /** Lê o arquivo em uploads e devolve `data:<mime>;base64,...`. */
  private async toDataUri(fileUrl: string): Promise<string> {
    const uploadsDir = path.resolve(this.config.get('UPLOAD_DEST', './uploads'));
    const abs = path.resolve(uploadsDir, fileUrl.replace(/^\/uploads\//, ''));
    if (!abs.startsWith(uploadsDir + path.sep)) {
      throw new TerminalProviderError(`Caminho de asset inválido: ${fileUrl}`, 'invalid_asset_path');
    }
    const buffer = await fs.readFile(abs).catch(() => {
      throw new TerminalProviderError(`Asset não encontrado no disco: ${fileUrl}`, 'asset_missing');
    });
    // base64 infla ~33%: o limite de 5MB do Runway equivale a 3.3MB de binário.
    if (buffer.length > MAX_INLINE_IMAGE_BYTES) {
      throw new TerminalProviderError(
        `Imagem de origem grande demais para envio inline: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (máx 3.3MB)`,
        'source_image_too_large',
      );
    }
    return `data:${mimeForFile(abs)};base64,${buffer.toString('base64')}`;
  }

  private async saveFile(
    userId: string,
    taskId: string,
    name: string,
    data: Buffer,
  ): Promise<string> {
    const uploadsDir = this.config.get('UPLOAD_DEST', './uploads');
    const dir = path.join(uploadsDir, 'animations', userId, taskId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), data);
    return `/uploads/animations/${userId}/${taskId}/${name}`;
  }

  private providerFor(name: string): RunwayProvider | FalKlingProvider | HeyGenProvider {
    switch (name) {
      case 'runway':
      case 'openai':
        return this.runway;
      case 'fal_kling':
        return this.falKling;
      case 'heygen':
        return this.heyGen;
      default:
        throw new Error(`Provider sem poll: ${name}`);
    }
  }
}
