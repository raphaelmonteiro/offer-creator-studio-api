import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DataSource, In } from 'typeorm';
import { Client } from '../../clients/entities/client.entity';
import { Mascot } from '../../mascots/entities/mascot.entity';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { ElevenLabsAlignment } from '../domain/mc-captions';
import {
  absoluteAssetUrl,
  buildOfferCarouselProps,
  carouselCaptionsOf,
  carouselFractionsToPx,
  carouselLayoutPresetOf,
  carouselPropsIssues,
  computeRenderRemotionPropsHash,
  McCarouselPropsError,
  OfferCarouselProps,
  OfferCarouselSpeechInput,
} from '../domain/mc-offer-carousel-props';
import { mcRenderAssetBaseUrl } from '../domain/mc-render.config';
import { carouselOffers } from '../domain/mc-script-v2';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { MC_TALK_GAP_MS } from '../domain/mc-talk-conform-graph';
import { McScript, McStepType, resolveProjectOptions } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McCarouselRendererService } from '../services/mc-carousel-renderer';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';

/** Tolerância entre a duração medida do render e a da composição (quadros/encoder). */
export const MC_RENDER_DURATION_TOLERANCE_MS = 400;

/**
 * Consumer do step de projeto `render_remotion` do F2 (fila `mc.render`,
 * concorrência 1, gate ResourceGuard — change video-formatos-personagem,
 * tarefa 6.5; design D3/D6/D7/D8).
 *
 * 1. As falas conformadas (cenas `talk_tile` prontas) viram as props da
 *    composição `OfferCarousel` (`buildOfferCarouselProps`): timeline pelas
 *    durações MEDIDAS + silêncios, palavras do alinhamento do TTS de cada fala,
 *    janela/caixa dos cards do preset, URLs absolutas (`MC_RENDER_ASSET_BASE_URL`).
 * 2. Hash EXATO = props canônicas + versão da composição + renderizador: um
 *    render anterior (do mesmo usuário) com o mesmo hash e arquivo presente é
 *    REAPROVEITADO sem renderizar de novo (spec "Render determinístico").
 * 3. Senão, o renderizador do ambiente (Remotion, ou o mock em ffmpeg) produz
 *    o MP4; o arquivo é verificado (vídeo + áudio, tamanho do quadro, duração
 *    ≈ falas + cartela) e publicado como `commercial_composed` com a timeline
 *    — a entrada do `finalize`, que NÃO queima legendas de novo no F2.
 */
@Injectable()
export class McRenderRemotionProcessor {
  private readonly logger = new Logger(McRenderRemotionProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
    private readonly renderers: McCarouselRendererService,
  ) {}

  async process({ stepId }: { stepId: string; projectId?: string }): Promise<void> {
    const step = await this.pipeline.claimStep(stepId, McStepType.RENDER_REMOTION);
    if (!step) return;
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!project) return;

    const scenes = (
      await this.dataSource.getRepository(McScene).find({
        where: { projectId: project.id },
        order: { idx: 'ASC' },
      })
    ).filter((s) => s.status !== McSceneStatus.CANCELED);
    // Re-roll/edição no meio do caminho: a composição mudou — o fluxo de edição cria outra cadeia.
    if (
      scenes.length === 0 ||
      scenes.some((s) => s.status !== McSceneStatus.READY || !s.finalAssetId)
    ) {
      await this.dataSource.transaction((m) =>
        m.getRepository(McStep).update(
          { id: stepId, status: McStepStatus.RUNNING },
          {
            status: McStepStatus.CANCELED,
            finishedAt: new Date(),
            errorCode: 'composition_changed',
          },
        ),
      );
      return;
    }

    const tempDir = await this.ffmpeg.createTempDir('mc-render-');
    try {
      const renderer = this.renderers.current();
      const { props, timeline, localFiles } = await this.buildProps(project, scenes);
      const issues = carouselPropsIssues(props);
      if (issues.length > 0) {
        throw new TerminalProviderError(
          `Layout/props do F2 inválidos: ${issues
            .map((i) => i.message)
            .join(' | ')
            .slice(0, 400)}`,
          'CAROUSEL_LAYOUT_INVALID',
        );
      }
      const compositionVersion = await renderer.compositionVersion();
      const propsHash = computeRenderRemotionPropsHash({
        props,
        compositionVersion,
        renderer: renderer.kind,
      });
      const snapshot: Record<string, unknown> = {
        propsHash,
        compositionVersion,
        renderer: renderer.kind,
        props,
      };

      // 2) reaproveitamento por hash (mesmo usuário, arquivo ainda no disco)
      const reused = await this.reusableRender(project.userId, propsHash, step.id);
      if (reused) {
        await this.dataSource.transaction(async (manager) => {
          await manager.update(
            McStep,
            { id: step.id },
            {
              inputHash: propsHash,
              inputSnapshot: { ...snapshot, reusedFromStepId: reused.stepId },
            },
          );
          await this.pipeline.completeStepAndAdvance(manager, step, {
            from: McStepStatus.RUNNING,
            outputAssetId: reused.assetId,
            provider: 'cache',
            consumeOnSuccess: false,
          });
        });
        return;
      }

      // 3) render
      const output = path.join(tempDir, 'rendered.mp4');
      await renderer.render({
        props,
        localFiles,
        outputPath: output,
        tempDir,
        onProgress: (pct) => this.reportProgress(step, project, pct),
      });
      const probe = await this.ffmpeg.probe(output);
      const expectedMs = Math.round(timeline.totalS * 1000);
      if (!probe.hasVideo || !probe.hasAudio) {
        throw new TerminalProviderError('Render sem vídeo ou sem áudio', 'render_invalid');
      }
      if (probe.width !== props.width || probe.height !== props.height) {
        throw new TerminalProviderError(
          `Render em ${probe.width}×${probe.height}, esperado ${props.width}×${props.height}`,
          'render_dimensions_mismatch',
        );
      }
      if (
        probe.durationMs != null &&
        Math.abs(probe.durationMs - expectedMs) > MC_RENDER_DURATION_TOLERANCE_MS
      ) {
        throw new TerminalProviderError(
          `Render com ${probe.durationMs} ms, esperado ${expectedMs} ms`,
          'render_duration_mismatch',
        );
      }

      // publica em /final/v{n}/rendered.mp4 (mesma pasta do finalize da entrega)
      const version = await this.nextDeliveryVersion(project.id);
      const relDir = this.storage.finalRelDir(project.userId, project.id, version);
      const target = await this.storage.prepareStreamTarget(relDir, 'rendered.mp4');
      await this.storage.copyFile(output, target.partPath);
      await this.ffmpeg.finalizeOutput(target.partPath, target.finalPath);
      const fileSize = (await fs.stat(target.finalPath)).size;

      await this.dataSource.transaction(async (manager) => {
        const asset = await manager.getRepository(AnimationAsset).save({
          userId: project.userId,
          kind: 'commercial_composed' as const,
          status: 'ready' as const,
          name: `Render — ${project.title.slice(0, 60)} (v${version})`,
          origin: 'ai_generated' as const,
          fileUrl: target.url,
          mimeType: 'video/mp4',
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          fileSize: String(fileSize),
          metadata: {
            projectId: project.id,
            version,
            format: 'offer_carousel',
            aspectRatio: project.aspectRatio,
            renderer: renderer.kind,
            compositionVersion,
            propsHash,
            layoutPreset: props.layoutPreset,
            captions: props.captions,
            // a composição já desenha a cartela (logo depois da última fala) e as legendas
            endcard: false,
            captionsRendered: props.captions,
            tailS: Number((timeline.totalS - timeline.speechEndS).toFixed(3)),
            windowPx: (() => {
              const px = carouselFractionsToPx(props.character.window, props.width, props.height);
              return { x: px.x, y: px.y, width: px.width, height: px.height };
            })(),
            timeline: {
              totalS: timeline.speechEndS,
              scenes: timeline.scenes.map((entry) => {
                const scene = scenes.find((s) => (s.scriptSceneId ?? s.id) === entry.sceneId);
                return {
                  sceneId: entry.sceneId,
                  idx: scene?.idx ?? 0,
                  finalAssetId: scene?.finalAssetId ?? '',
                  startS: entry.startS,
                  endS: entry.endS,
                };
              }),
            },
          },
        });
        await manager.update(
          McStep,
          { id: step.id },
          { inputHash: propsHash, inputSnapshot: snapshot },
        );
        await this.pipeline.completeStepAndAdvance(manager, step, {
          from: McStepStatus.RUNNING,
          outputAssetId: asset.id,
          provider: renderer.kind === 'mock' ? 'mock' : 'remotion',
          consumeOnSuccess: true, // tabela: 0 (render determinístico)
        });
      });
    } catch (err) {
      const error =
        err instanceof McCarouselPropsError
          ? new TerminalProviderError(err.message, err.code)
          : err;
      this.logger.error(`render_remotion ${stepId} falhou: ${(error as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.RUNNING, error, {
        fallbackCode: 'render_failed',
      });
    } finally {
      await this.ffmpeg.removeTempDir(tempDir);
    }
  }

  /**
   * Entradas do render a partir do projeto: falas na ordem do roteiro (cena,
   * clipe conformado medido, alinhamento do TTS), tile/cor da janela do kit,
   * marca (logo do cliente do mascote/logo do kit e nome da loja) e o mapa
   * URL absoluta → arquivo local (o mock lê do disco).
   */
  async buildProps(
    project: McProject,
    scenes: McScene[],
  ): Promise<{
    props: OfferCarouselProps;
    timeline: ReturnType<typeof buildOfferCarouselProps>['timeline'];
    localFiles: Record<string, string>;
  }> {
    const script = (project.script ?? null) as McScript | null;
    if (!script || script.format !== 'offer_carousel' || !script.lines?.length) {
      throw new TerminalProviderError(
        'Roteiro sem as falas de "ofertas em sequência"',
        'CAROUSEL_SCRIPT_INVALID',
      );
    }
    const assets = await this.dataSource.getRepository(AnimationAsset).find({
      where: {
        id: In(
          scenes
            .flatMap((s) => [s.finalAssetId, s.audioAssetId])
            .filter((id): id is string => !!id),
        ),
      },
    });
    const localFiles: Record<string, string> = {};
    const baseUrl = mcRenderAssetBaseUrl();
    const speeches: OfferCarouselSpeechInput[] = [];
    for (const line of script.lines) {
      const scene = scenes.find((s) => s.scriptSceneId === line.sceneId);
      const clip = scene ? assets.find((a) => a.id === scene.finalAssetId) : null;
      const absolute = clip?.fileUrl ? this.storage.absoluteFromUrl(clip.fileUrl) : null;
      if (!scene || !clip?.fileUrl || !absolute) {
        throw new TerminalProviderError(
          `Clipe da fala ${line.sceneId} ausente`,
          'scene_asset_missing',
        );
      }
      const probe = await this.ffmpeg.probe(absolute);
      if (!probe.hasVideo || !probe.hasAudio) {
        throw new TerminalProviderError(
          `Clipe da fala ${scene.idx + 1} sem vídeo ou sem áudio`,
          'invalid_scene_clip',
        );
      }
      const audio = scene.audioAssetId ? assets.find((a) => a.id === scene.audioAssetId) : null;
      speeches.push({
        sceneId: line.sceneId,
        durationMs: probe.durationMs ?? clip.durationMs ?? scene.durationS * 1000,
        clipUrl: clip.fileUrl,
        alignment: (audio?.metadata?.alignment ?? null) as ElevenLabsAlignment | null,
      });
      localFiles[absoluteAssetUrl(clip.fileUrl, baseUrl)] = absolute;
    }

    const kit = await this.dataSource
      .getRepository(McCharacterKit)
      .findOneBy({ id: project.kitId });
    const tile = kit?.tileAssetId
      ? await this.dataSource.getRepository(AnimationAsset).findOneBy({ id: kit.tileAssetId })
      : null;
    const backgroundColor = (
      script.talkBackgroundColor?.trim() ||
      kit?.tileBackgroundColor?.trim() ||
      '#FFFFFF'
    ).toUpperCase();
    const logoUrl = await this.brandLogoUrl(kit);
    const options = resolveProjectOptions(project.options);
    const built = buildOfferCarouselProps({
      aspectRatio: project.aspectRatio,
      offers: carouselOffers(script),
      lines: script.lines,
      speeches,
      layoutPreset: carouselLayoutPresetOf(script, project),
      captions: carouselCaptionsOf(script, options),
      tile: {
        width: tile?.width ?? null,
        height: tile?.height ?? null,
        url: tile?.fileUrl ?? null,
      },
      characterBackgroundColor: backgroundColor,
      brand: { logoUrl, name: script.endcard?.storeName ?? null },
      assetBaseUrl: baseUrl,
      gapMs: MC_TALK_GAP_MS,
    });
    for (const url of [tile?.fileUrl, logoUrl, ...carouselOffers(script).map((o) => o.imageUrl)]) {
      const local = url ? this.storage.absoluteFromUrl(url) : null;
      if (url && local) localFiles[absoluteAssetUrl(url, baseUrl)] = local;
    }
    return { props: built.props, timeline: built.timeline, localFiles };
  }

  /** Logo da marca: o logo enviado do kit de logo, senão o logo do cliente do mascote. */
  private async brandLogoUrl(kit: McCharacterKit | null): Promise<string | null> {
    if (!kit?.mascotId) return null;
    try {
      const mascot = await this.dataSource.getRepository(Mascot).findOneBy({ id: kit.mascotId });
      if (!mascot) return null;
      if (kit.source === 'logo') return mascot.cutoutUrl ?? mascot.sourceImageUrl ?? null;
      if (!mascot.clientId) return null;
      const client = await this.dataSource.getRepository(Client).findOneBy({ id: mascot.clientId });
      return client?.logoUrl ?? null;
    } catch {
      return null; // logo é enfeite: sem ele a composição mostra o nome da loja
    }
  }

  /**
   * Render anterior com as MESMAS props (hash), do mesmo usuário, com arquivo
   * presente → reaproveitado. `excludeStepId` = o step corrente.
   */
  private async reusableRender(
    userId: string,
    propsHash: string,
    excludeStepId: string,
  ): Promise<{ stepId: string; assetId: string } | null> {
    const row = await this.dataSource
      .getRepository(McStep)
      .createQueryBuilder('s')
      .innerJoin(McProject, 'p', 'p.id = s."projectId"')
      .where('p."userId" = :userId', { userId })
      .andWhere('s.type = :type', { type: McStepType.RENDER_REMOTION })
      .andWhere('s."inputHash" = :propsHash', { propsHash })
      .andWhere('s.status = :status', { status: McStepStatus.SUCCEEDED })
      .andWhere('s."outputAssetId" IS NOT NULL')
      .andWhere('s.id <> :excludeStepId', { excludeStepId })
      .orderBy('s."finishedAt"', 'DESC')
      .getOne();
    if (!row?.outputAssetId) return null;
    const asset = await this.dataSource
      .getRepository(AnimationAsset)
      .findOneBy({ id: row.outputAssetId });
    const file = asset?.fileUrl ? this.storage.absoluteFromUrl(asset.fileUrl) : null;
    if (!file) return null;
    const exists = await fs
      .stat(file)
      .then((st) => st.size > 0)
      .catch(() => false);
    return exists ? { stepId: row.id, assetId: row.outputAssetId } : null;
  }

  /** Versão da entrega = finalizações entregues + 1 (render e finalize da mesma entrega partilham a pasta). */
  private async nextDeliveryVersion(projectId: string): Promise<number> {
    const delivered = await this.dataSource.getRepository(McStep).count({
      where: { projectId, type: McStepType.FINALIZE, status: McStepStatus.SUCCEEDED },
    });
    return delivered + 1;
  }

  private async reportProgress(step: McStep, project: McProject, pct: number): Promise<void> {
    const bounded = Math.max(0, Math.min(100, Math.round(pct)));
    await this.dataSource
      .transaction((manager) =>
        this.pipeline.notifyStep(manager, project.userId, step, McStepStatus.RUNNING, {
          progressPct: bounded,
        }),
      )
      .catch(() => undefined);
  }
}
