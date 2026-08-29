import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import * as sharp from 'sharp';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { GeminiImageProvider } from '../../../shared/providers/gemini-image.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { KitCanonicalDesc, parseCanonicalDesc } from '../domain/kit-prompts';
import { buildKeyframePrompt } from '../domain/mc-scene-prompts';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';

/** Máximo de referências do kit anexadas ao prompt (plano B1b: 2–3 — custo × fidelidade). */
export const KEYFRAME_MAX_REFERENCES = 3;

/** Tamanho do PNG por aspecto (Gemini decide o real; o mock usa isto). */
const SIZE_BY_ASPECT: Record<string, { w: number; h: number }> = {
  '9:16': { w: 720, h: 1280 },
  '16:9': { w: 1280, h: 720 },
  '1:1': { w: 1024, h: 1024 },
};

/**
 * Consumer de steps `keyframe` na fila mc.image existente (o dispatcher do
 * CommercialsModule separa payloads de kit {kitId} dos de step {stepId}).
 *
 * Gera o keyframe da cena via Nano Banana (GeminiImageProvider) com prompt =
 * ação da cena + descrição canônica do kit + estilo, e 2–3 referências do kit
 * como inlineData (plano §5.1 etapa 2). Salva o asset kind `keyframe` em
 * uploads/commercials/{userId}/{projectId}/scenes/{idx}/g{gen}/ e CONSOME o
 * custo do step no sucesso (plano §6.7 — síncrono barato).
 *
 * MC_PIPELINE_PROVIDER=mock: PNG sintético via sharp — nada de API, custo zero.
 */
@Injectable()
export class McKeyframeProcessor {
  private readonly logger = new Logger(McKeyframeProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly gemini: GeminiImageProvider,
    private readonly storage: McStorageService,
  ) {}

  private provider(): string {
    return process.env.MC_PIPELINE_PROVIDER || 'mock';
  }

  async process({ stepId }: { stepId: string; projectId?: string }): Promise<void> {
    const step = await this.pipeline.claimStep(stepId, McStepType.KEYFRAME);
    if (!step || !step.sceneId) return;

    const scene = await this.dataSource.getRepository(McScene).findOneBy({ id: step.sceneId });
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!scene || !project) return;

    try {
      const kit = await this.dataSource
        .getRepository(McCharacterKit)
        .findOneByOrFail({ id: project.kitId });
      const image =
        this.provider() === 'mock'
          ? await this.mockKeyframe(project.aspectRatio, scene.idx)
          : await this.generateKeyframe(project, scene, kit);

      const relDir = this.storage.sceneRelDir(
        project.userId,
        project.id,
        scene.idx,
        scene.generation,
      );
      const fileUrl = await this.storage.saveFile(relDir, `keyframe-${Date.now()}.png`, image);

      await this.dataSource.transaction(async (manager) => {
        const asset = await manager.getRepository(AnimationAsset).save({
          userId: project.userId,
          kind: 'keyframe' as const,
          status: 'ready' as const,
          name: `Keyframe cena ${scene.idx + 1} — ${project.title.slice(0, 40)}`,
          origin: 'ai_generated' as const,
          fileUrl,
          mimeType: 'image/png',
          fileSize: String(image.length),
          contentHash: step.inputHash,
          metadata: {
            projectId: project.id,
            sceneId: scene.id,
            generation: scene.generation,
            provider: this.provider(),
          },
        });
        await this.pipeline.completeStepAndAdvance(manager, step, {
          from: McStepStatus.RUNNING,
          outputAssetId: asset.id,
          provider: this.provider(),
          consumeOnSuccess: true, // consumo no sucesso (plano §6.7)
        });
      });
    } catch (err) {
      this.logger.error(`Keyframe ${stepId} falhou: ${(err as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.RUNNING, err, {
        fallbackCode: 'keyframe_failed',
      });
    }
  }

  /** Nano Banana com 2–3 referências do kit (inlineData) — a identidade vem do kit (plano §4). */
  private async generateKeyframe(
    project: McProject,
    scene: McScene,
    kit: McCharacterKit,
  ): Promise<Buffer> {
    const references = await this.loadKitReferences(kit);
    if (references.length === 0) {
      throw new TerminalProviderError(
        'Kit sem referências utilizáveis no disco — regenere o kit',
        'kit_references_missing',
      );
    }
    const prompt = buildKeyframePrompt(
      scene.actionPrompt,
      this.parseCanonicalDesc(kit.canonicalDesc),
      project.aspectRatio,
    );
    return this.gemini.generateImage({
      prompt,
      referenceImages: references,
      aspectRatio: project.aspectRatio, // v0: projetos nascem 9:16 (default da entity)
    });
  }

  /** 2–3 referências do kit lidas do bucket, priorizando os slots do grid (0..3). */
  private async loadKitReferences(kit: McCharacterKit): Promise<Buffer[]> {
    if (kit.referenceAssetIds.length === 0) return [];
    const assets = await this.dataSource.getRepository(AnimationAsset).find({
      where: { id: In(kit.referenceAssetIds) },
    });
    assets.sort((a, b) => {
      const slotA = typeof a.metadata?.slot === 'number' ? (a.metadata.slot as number) : 99;
      const slotB = typeof b.metadata?.slot === 'number' ? (b.metadata.slot as number) : 99;
      return slotA - slotB;
    });
    const buffers: Buffer[] = [];
    for (const asset of assets) {
      if (buffers.length >= KEYFRAME_MAX_REFERENCES) break;
      if (!asset.fileUrl) continue;
      const buffer = await this.storage.readUploadsFile(asset.fileUrl);
      if (buffer) buffers.push(buffer);
    }
    return buffers;
  }

  private parseCanonicalDesc(raw: string | null): KitCanonicalDesc | null {
    return parseCanonicalDesc(raw);
  }

  /** PNG sintético (custo zero) — gradiente + rótulo, no aspecto do projeto. */
  private async mockKeyframe(aspectRatio: string, idx: number): Promise<Buffer> {
    const { w, h } = SIZE_BY_ASPECT[aspectRatio] ?? SIZE_BY_ASPECT['9:16'];
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#3E6DA8"/><stop offset="1" stop-color="#25406B"/>` +
      `</linearGradient></defs>` +
      `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
      `<circle cx="${w / 2}" cy="${h * 0.4}" r="${Math.round(w * 0.2)}" fill="#FFCC00"/>` +
      `<text x="${w / 2}" y="${h * 0.75}" font-family="sans-serif" font-size="${Math.round(w / 18)}" ` +
      `fill="#ffffff" text-anchor="middle">keyframe mock — cena ${idx + 1}</text>` +
      `</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }
}
