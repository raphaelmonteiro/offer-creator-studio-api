import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { FalQueueClient } from '../../../shared/providers/fal-queue.client';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { buildPosterArgs } from '../domain/mc-assembly-graph';
import { speechWindowsFromAlignment, SpeechWindow } from '../domain/mc-captions';
import {
  isAllowedFalVideoUrl,
  MC_INGEST_MAX_BYTES,
  mcUsdPerSecond,
  mcUsdPerSecondForModel,
} from '../domain/mc-pipeline.config';
import { McStepStatus } from '../domain/mc-state-machines';
import {
  buildTalkConformArgs,
  conformedOutputIssue,
  planTalkConform,
  TalkConformPlan,
} from '../domain/mc-talk-conform-graph';
import { McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import {
  ClipInspection,
  ClipInspectionContext,
  McClipInspectorService,
} from '../services/mc-clip-inspector.service';
import { MC_CLIP_TOO_SHORT_ERROR_CODE, mcShouldRetry } from '../domain/mc-error-classes';

/** Snapshot do step `talk` que o ingest lê (gravado pelo materializer e completado no submit). */
interface TalkIngestSnapshot {
  audioAssetId?: string | null;
  tileAssetId?: string | null;
  tileWidth?: number | null;
  tileHeight?: number | null;
  tier?: string | null;
  engine?: { key?: string; model?: string } | null;
  effectiveEngine?: { key?: string; model?: string; fallbackFrom?: string } | null;
}

/** Resultado da conformação do clipe falado ao áudio (D7) — vai ao metadata do asset. */
interface TalkConformRecord {
  /** Plano EXECUTADO (no aceite por teto esgotado, o replanejado com clone ilimitado). */
  plan: TalkConformPlan;
  /** Veredito do plano original (`too_short` quando o clipe foi aceito no teto). */
  verdict: TalkConformPlan['durationAction'];
  /**
   * Aceite do clipe curto demais após esgotar a classe `quality` (mesma regra
   * de `McClipInspectorService.decision`): sinaliza a cena para revisão humana.
   */
  accepted: { reason: typeof MC_CLIP_TOO_SHORT_ERROR_CODE; executions: number } | null;
  rawDurationMs: number | null;
  rawWidth: number | null;
  rawHeight: number | null;
  audioMs: number;
  audioAssetId: string;
}

/**
 * Consumer da fila mc.ingest (conc. 2, gate ResourceGuard — plano §6.4):
 * baixa o vídeo pronto do provider e o transforma no asset final da cena.
 *
 * Anti-SSRF endurecido (plano §6.8 — o ingest do animations não tem nada
 * disso): a URL do vídeo sai do RESULTADO do provider e mesmo assim só é
 * baixada se for https com hostname na allowlist da fal (fal.media,
 * *.fal.media, *.fal.run — hostname PARSEADO, nunca substring); cap de 200MB
 * com contagem durante o stream; escrita em .part + rename atômico; ffprobe
 * valida que é vídeo de verdade ANTES de virar asset; poster (frame 0) +
 * thumb 320px (sharp).
 *
 * Provider mock: lê o clipe de mock-jobs/ direto do disco (nada de rede) —
 * o caminho real de validação/probe/poster roda igual.
 *
 * Step `talk` (change video-formatos-personagem, D7/D11): antes do asset, o
 * clipe é CONFORMADO ao áudio da fala (aparado, último quadro clonado até
 * 300 ms, ou reprovado como `clip_too_short` — classe `quality`, nova geração
 * até o teto; esgotado, aceito com o último quadro clonado e sinalizado para
 * revisão humana), recortado ao aspecto do tile e remuxado com o TTS original
 * (áudio do fornecedor descartado); a inspeção recebe origem/estilo/fundo liso
 * e as janelas de fala do alinhamento.
 */
@Injectable()
export class McIngestProcessor {
  private readonly logger = new Logger(McIngestProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly fal: FalQueueClient,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
    private readonly inspector: McClipInspectorService,
  ) {}

  async process({ stepId, responseUrl }: { stepId: string; responseUrl?: string }): Promise<void> {
    const step = await this.dataSource.getRepository(McStep).findOneBy({ id: stepId });
    // Só steps que o poll moveu para ingesting; re-entrega dupla é resolvida
    // no CAS final (o segundo download perde e vira no-op).
    if (!step || step.status !== McStepStatus.INGESTING) return;

    const scene = step.sceneId
      ? await this.dataSource.getRepository(McScene).findOneBy({ id: step.sceneId })
      : null;
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!scene || !project) return;
    const tempDir = await this.ffmpeg.createTempDir('mc-ingest-');
    this.logger.log(`Ingest ${stepId}: início (provider=${step.provider})`);
    try {
      const videoPath = path.join(tempDir, 'video.mp4');
      if (step.provider === 'mock') {
        await this.copyMockClip(step.providerJobId as string, videoPath);
      } else {
        const videoUrl = await this.fal.resultVideoUrl(
          responseUrl ?? `https://queue.fal.run/${step.provider}/requests/${step.providerJobId}`,
        );
        this.assertAllowedUrl(videoUrl);
        await this.downloadStream(videoUrl, videoPath);
      }

      this.logger.log(`Ingest ${stepId}: vídeo no disco, probe`);
      // ffprobe ANTES de aceitar (plano §6.8): sem stream de vídeo = lixo.
      const probe = await this.ffmpeg.probe(videoPath).catch((err: Error) => {
        throw new TerminalProviderError(
          `ffprobe rejeitou o download: ${err.message}`,
          'invalid_video',
        );
      });
      if (!probe.hasVideo) {
        throw new TerminalProviderError('Download sem stream de vídeo', 'invalid_video');
      }

      // talk (D7): conformar ao áudio ANTES de inspecionar/publicar — a
      // inspeção e o asset final olham o clipe que a composição vai usar.
      const talk = step.type === McStepType.TALK;
      let finalVideoPath = videoPath;
      let measured = { width: probe.width, height: probe.height, durationMs: probe.durationMs };
      let conform: TalkConformRecord | null = null;
      let speechWindows: SpeechWindow[] = [];
      if (talk) {
        const result = await this.conformTalkClip(step, scene, tempDir, videoPath, probe);
        finalVideoPath = result.path;
        measured = result.measured;
        conform = result.record;
        speechWindows = result.speechWindows;
      }

      // Inspeção de qualidade (opção B, 24/09; D11): texto inventado,
      // deformação e boca parada nas janelas de fala → reprova (classe
      // `quality` = nova geração) até o teto; depois aceita e registra.
      // Indisponível → aceito como "não inspecionado" (sinalizado no asset).
      // Só clipes reais do pipeline v2 (steps com fase).
      let inspection: ClipInspection | null = null;
      if (step.provider !== 'mock' && step.phase != null) {
        const kit = await this.dataSource
          .getRepository(McCharacterKit)
          .findOneBy({ id: project.kitId });
        const ctx: ClipInspectionContext = {
          source: kit?.source ?? 'mascot',
          style: kit?.style ?? null,
          backgroundKind: talk ? 'plain' : 'scene',
          speechWindows,
        };
        inspection = await this.inspector.inspect(
          finalVideoPath,
          measured.durationMs ?? 0,
          tempDir,
          ctx,
        );
        const decision = McClipInspectorService.decision(inspection, step.attempts);
        if (decision === 'retry') {
          throw new TerminalProviderError(
            `Clipe reprovado na inspeção (${inspection.reasons.join(', ')}${inspection.where ? `, ${inspection.where}` : ''}): ${inspection.description}`,
            McClipInspectorService.errorCodeFor(inspection),
          );
        }
        if (decision === 'accept') {
          this.logger.warn(
            `Ingest ${stepId}: clipe reprovado (${inspection.reasons.join(', ')}) após ${step.attempts} gerações — aceito: ${inspection.description}`,
          );
        }
      }
      this.logger.log(`Ingest ${stepId}: probe ok, poster`);
      const posterPath = path.join(tempDir, 'poster.jpg');
      await this.ffmpeg.run(buildPosterArgs(finalVideoPath, posterPath), {
        durationMs: 1000,
        timeoutMs: 60_000,
      });
      const posterBuffer = await fs.readFile(posterPath);
      this.logger.log(`Ingest ${stepId}: poster ok, thumb`);
      const thumbBuffer = await sharp(posterBuffer)
        .resize({ width: 320 })
        .jpeg({ quality: 80 })
        .toBuffer();
      this.logger.log(`Ingest ${stepId}: thumb ok, publicando asset`);

      const relDir = this.storage.sceneRelDir(
        project.userId,
        project.id,
        scene.idx,
        scene.generation,
      );
      const stamp = Date.now();
      const target = await this.storage.prepareStreamTarget(relDir, `synced-${stamp}.mp4`);
      await this.storage.copyFile(finalVideoPath, target.partPath);
      await this.ffmpeg.finalizeOutput(target.partPath, target.finalPath);
      const videoFileUrl = target.url;
      const posterUrl = await this.storage.saveFile(
        relDir,
        `synced-${stamp}-poster.jpg`,
        posterBuffer,
      );
      const thumbUrl = await this.storage.saveFile(
        relDir,
        `synced-${stamp}-thumb.jpg`,
        thumbBuffer,
      );
      const fileSize = (await fs.stat(target.finalPath)).size;

      // Custo real por SEGUNDO de saída do MOTOR que gerou o clipe (D2:
      // tarifa por modelo; cai na tarifa por tipo de step quando o modelo não
      // é reconhecido). Segundos do clipe CRU do provider, antes da conformação.
      const usdPerSecond = mcUsdPerSecondForModel(step.provider) ?? mcUsdPerSecond(step.type);
      const providerCostUsd =
        step.provider === 'mock' || probe.durationMs == null
          ? 0
          : (probe.durationMs / 1000) * usdPerSecond;
      const snapshot = (step.inputSnapshot ?? null) as TalkIngestSnapshot | null;
      const engineRecord = talk
        ? {
            engine: {
              key: snapshot?.effectiveEngine?.key ?? snapshot?.engine?.key ?? null,
              model: step.provider,
              usdPerSecond,
              ...(snapshot?.effectiveEngine?.fallbackFrom
                ? { fallbackFrom: snapshot.effectiveEngine.fallbackFrom }
                : {}),
            },
            tier: snapshot?.tier ?? project.tier ?? 'economico',
          }
        : {};

      this.logger.log(`Ingest ${stepId}: arquivos gravados, transação`);
      await this.dataSource.transaction(async (manager) => {
        const asset = await manager.getRepository(AnimationAsset).save({
          userId: project.userId,
          // lipsync/talk = cena falada sincronizada; video = clipe cru de cena muda
          kind:
            step.type === McStepType.LIPSYNC || talk
              ? ('scene_synced' as const)
              : ('scene_clip' as const),
          status: 'ready' as const,
          name: `Cena ${scene.idx + 1} — ${project.title.slice(0, 40)}`,
          origin: 'ai_generated' as const,
          fileUrl: videoFileUrl,
          posterUrl,
          thumbUrl,
          mimeType: 'video/mp4',
          // dimensões/duração MEDIDAS do arquivo publicado (conformado no talk)
          width: measured.width,
          height: measured.height,
          durationMs: measured.durationMs,
          fileSize: String(fileSize),
          metadata: {
            projectId: project.id,
            sceneId: scene.id,
            generation: scene.generation,
            provider: step.provider,
            providerJobId: step.providerJobId,
            providerCostUsd: Number(providerCostUsd.toFixed(4)),
            ...engineRecord,
            ...(conform
              ? {
                  sceneType: 'talk_tile',
                  conform: {
                    // veredito do plano (`too_short` no aceite) × ação executada (`pad`)
                    durationAction: conform.verdict,
                    executedAction: conform.plan.durationAction,
                    deltaMs: conform.plan.deltaMs,
                    padS: conform.plan.padS,
                    crop: conform.plan.crop,
                    rawDurationMs: conform.rawDurationMs,
                    rawWidth: conform.rawWidth,
                    rawHeight: conform.rawHeight,
                    audioMs: conform.audioMs,
                    audioAssetId: conform.audioAssetId,
                    audioPolicy: 'replace_clip_audio',
                    // teto da classe `quality` esgotado: aceito e sinalizado para
                    // revisão humana (mesmo marcador de `inspection.accepted`)
                    ...(conform.accepted
                      ? {
                          accepted: true,
                          acceptedReason: conform.accepted.reason,
                          executions: conform.accepted.executions,
                        }
                      : {}),
                  },
                }
              : {}),
            ...(inspection
              ? {
                  inspected: inspection.available,
                  inspection: {
                    ...inspection,
                    accepted: inspection.flagged,
                    executions: step.attempts,
                  },
                }
              : {}),
          },
        });
        // Conclui + cena ready (este é o step final da cena falada/muda) +
        // avanço do scheduler (assembly quando todas prontas) NA TRANSAÇÃO.
        await this.pipeline.completeStepAndAdvance(manager, step, {
          from: McStepStatus.INGESTING,
          outputAssetId: asset.id,
          providerCostUsd,
          consumeOnSuccess: false, // consumo já aconteceu no submit (§6.7)
        });
      });
    } catch (err) {
      this.logger.error(`Ingest ${stepId} falhou: ${(err as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.INGESTING, err, {
        fallbackCode: 'ingest_failed',
      });
    } finally {
      await this.ffmpeg.removeTempDir(tempDir);
    }
  }

  // ─────────────────────────────── interno ───────────────────────────────

  /**
   * Conformação do clipe `talk` ao áudio (D7): probe das duas durações; plano
   * puro (`planTalkConform`); `clip_too_short` → classe `quality` (nova
   * geração até o teto; esgotado, aceite com clone ilimitado do último
   * quadro); senão ffmpeg (aparar/clonar/recortar + TTS original muxado) e
   * probe de verificação. Devolve o arquivo conformado, as medidas e as
   * janelas de fala (do alinhamento do áudio) para a inspeção.
   */
  private async conformTalkClip(
    step: McStep,
    scene: McScene,
    tempDir: string,
    videoPath: string,
    probe: { width: number | null; height: number | null; durationMs: number | null },
  ): Promise<{
    path: string;
    measured: { width: number | null; height: number | null; durationMs: number | null };
    record: TalkConformRecord;
    speechWindows: SpeechWindow[];
  }> {
    const snapshot = (step.inputSnapshot ?? null) as TalkIngestSnapshot | null;
    const audioAssetId = snapshot?.audioAssetId ?? scene.audioAssetId;
    if (!audioAssetId) {
      throw new TerminalProviderError(
        'Cena sem áudio selecionado para conformar',
        'missing_input_asset',
      );
    }
    const audioAsset = await this.dataSource
      .getRepository(AnimationAsset)
      .findOneBy({ id: audioAssetId });
    const audioBuffer = audioAsset?.fileUrl
      ? await this.storage.readUploadsFile(audioAsset.fileUrl)
      : null;
    if (!audioAsset || !audioBuffer) {
      throw new TerminalProviderError('Áudio da fala ausente no disco', 'missing_input_asset');
    }
    const audioPath = path.join(tempDir, 'voice.mp3');
    await fs.writeFile(audioPath, audioBuffer);
    const audioProbe = await this.ffmpeg.probe(audioPath).catch(() => null);
    const audioMs = audioProbe?.durationMs ?? audioAsset.durationMs ?? null;
    if (audioMs == null || probe.durationMs == null) {
      throw new TerminalProviderError(
        'Duração do áudio ou do clipe desconhecida — impossível conformar',
        'invalid_video',
      );
    }
    // Aspecto do tile: snapshot (materializer) ou o asset do tile.
    let tileWidth = snapshot?.tileWidth ?? null;
    let tileHeight = snapshot?.tileHeight ?? null;
    if ((tileWidth == null || tileHeight == null) && snapshot?.tileAssetId) {
      const tile = await this.dataSource
        .getRepository(AnimationAsset)
        .findOneBy({ id: snapshot.tileAssetId });
      tileWidth = tile?.width ?? null;
      tileHeight = tile?.height ?? null;
    }
    const conformInput = {
      videoMs: probe.durationMs,
      audioMs,
      videoWidth: probe.width,
      videoHeight: probe.height,
      tileWidth,
      tileHeight,
    };
    let plan = planTalkConform(conformInput);
    const verdict = plan.durationAction;
    let accepted: TalkConformRecord['accepted'] = null;
    if (plan.durationAction === 'too_short') {
      // Classe `quality` (boca parada): nova geração até o teto — a MESMA
      // regra de McClipInspectorService.decision. Esgotado o teto, não vira
      // terminal: o último clipe é aceito com o último quadro clonado até o
      // áudio e a cena fica sinalizada para revisão humana.
      if (mcShouldRetry('quality', step.attempts)) {
        throw new TerminalProviderError(
          `Clipe ${plan.deltaMs} ms mais curto que o áudio (boca parada) — regerar`,
          MC_CLIP_TOO_SHORT_ERROR_CODE,
        );
      }
      this.logger.warn(
        `Ingest ${step.id}: clipe ${plan.deltaMs} ms mais curto que o áudio após ` +
          `${step.attempts} gerações — aceito com o último quadro clonado (revisão humana)`,
      );
      plan = planTalkConform({ ...conformInput, padMaxMs: Infinity });
      accepted = { reason: MC_CLIP_TOO_SHORT_ERROR_CODE, executions: step.attempts };
    }
    const output = path.join(tempDir, 'conformed.mp4');
    this.logger.log(
      `Ingest ${step.id}: conformando clipe ao áudio (${plan.durationAction}, Δ=${plan.deltaMs}ms` +
        `${plan.crop ? `, recorte ${plan.crop.width}x${plan.crop.height}` : ''})`,
    );
    await this.ffmpeg.run(
      buildTalkConformArgs({ videoPath, audioPath, output, plan, audioDurationS: audioMs / 1000 }),
      { durationMs: audioMs, timeoutMs: 180_000 },
    );
    const conformedProbe = await this.ffmpeg.probe(output).catch((err: Error) => {
      throw new TerminalProviderError(
        `ffprobe rejeitou o clipe conformado: ${err.message}`,
        'talk_conform_failed',
      );
    });
    const issue = conformedOutputIssue(conformedProbe, audioMs);
    if (issue) {
      throw new TerminalProviderError(`Clipe conformado inválido: ${issue}`, 'talk_conform_failed');
    }
    const alignment = (audioAsset.metadata as { alignment?: unknown } | null)?.alignment;
    return {
      path: output,
      measured: {
        width: conformedProbe.width,
        height: conformedProbe.height,
        durationMs: conformedProbe.durationMs,
      },
      record: {
        plan,
        verdict,
        accepted,
        rawDurationMs: probe.durationMs,
        rawWidth: probe.width,
        rawHeight: probe.height,
        audioMs,
        audioAssetId,
      },
      speechWindows: speechWindowsFromAlignment(
        alignment as Parameters<typeof speechWindowsFromAlignment>[0],
      ),
    };
  }

  /** Validação exportável no domain (mc-pipeline.config) — aqui só o erro tipado. */
  private assertAllowedUrl(url: string): void {
    if (!isAllowedFalVideoUrl(url)) {
      throw new TerminalProviderError(
        `URL de vídeo fora da allowlist do provider: ${url.slice(0, 120)}`,
        'ingest_blocked_host',
      );
    }
  }

  /** Download por stream com cap de 200MB (aborta no meio — nunca bufferiza tudo em RAM). */
  private async downloadStream(url: string, destPath: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new TransientProviderError(`Falha de rede no download: ${(err as Error).message}`);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new TransientProviderError(`Download HTTP ${response.status}`);
    }
    if (!response.ok || !response.body) {
      throw new TerminalProviderError(
        `Download rejeitado: HTTP ${response.status}`,
        'download_failed',
      );
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MC_INGEST_MAX_BYTES) {
      throw new TerminalProviderError(
        `Vídeo declara ${declared} bytes (> cap de 200MB)`,
        'video_too_large',
      );
    }
    const partPath = `${destPath}.part`;
    const handle = await fs.open(partPath, 'w');
    let received = 0;
    try {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.length;
          if (received > MC_INGEST_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new TerminalProviderError('Vídeo excedeu o cap de 200MB', 'video_too_large');
          }
          await handle.write(value);
        }
      }
    } finally {
      await handle.close();
    }
    await this.ffmpeg.finalizeOutput(partPath, destPath); // rename atômico
  }

  private async copyMockClip(jobId: string, destPath: string): Promise<void> {
    const mockPath = this.storage.mockJobAbsPath(jobId);
    try {
      await this.storage.copyFile(mockPath, destPath);
    } catch {
      throw new TerminalProviderError('Clipe mock ausente no disco', 'mock_job_missing');
    }
  }
}
