import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as sharp from 'sharp';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  GEMINI_VISION_MODEL,
  GeminiImageProvider,
} from '../../../shared/providers/gemini-image.provider';
import { compositionDimensions } from '../domain/mc-composition.config';
import {
  detectionsToOutputFrame,
  MC_PRICE_DETECT_PROMPT,
  MC_PRICE_DETECT_VERSION,
  mockPriceDetections,
  parseMockScenario,
  parsePriceDetectResponse,
} from '../domain/mc-price-detect';
import {
  defaultCharacterWindow,
  isWindowWellFormed,
  listWindowPresets,
  McArtTextDetection,
  McWindowPresetId,
  tileRatioOf,
  windowCoversPriceWarning,
} from '../domain/mc-talking-art-window';
import { McCharacterWindow } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McStorageService } from './mc-storage.service';

/** Aviso de janela sobre preço (um por preço coberto). `box` em frações do quadro de saída. */
export interface McWindowPriceWarningView {
  code: 'WINDOW_COVERS_PRICE';
  box: { x: number; y: number; w: number; h: number };
  text: string;
  message: string;
  /** Presets que não cobrem nenhum preço (sugestão da UI). */
  suggestedPresetIds: McWindowPresetId[];
}

export interface McWindowWarningsView {
  projectId: string;
  warnings: McWindowPriceWarningView[];
  /** Janela avaliada (roteiro ou default), em frações do quadro de saída. */
  window?: McCharacterWindow;
  frame?: { width: number; height: number };
  /** Preços detectados na arte (após o filtro de confiança da detecção). */
  detections?: number;
  /** true quando as detecções vieram do cache gravado no asset da arte. */
  cached?: boolean;
  model?: string;
  at?: string;
  mock?: true;
  /** Detecção indisponível (visão fora, timeout, resposta ilegível): avisos vazios, nunca erro HTTP. */
  error?: string;
  /** Avaliação não se aplica: formato sem janela, projeto sem arte, ou modo rosto do logo. */
  skipped?: 'not_talking_art' | 'no_art' | 'logo_face';
}

/** Cache das detecções no `metadata` do asset da arte (frações da ARTE). */
export interface McPriceDetectionsCache {
  version: number;
  model: string;
  at: string;
  detections: McArtTextDetection[];
}

/** Lado maior da arte enviada à visão (as caixas são fracionárias: reduzir não muda a resposta). */
const ART_MAX_SIDE = 1536;
/** Teto da detecção inteira (inclui retries): a rota responde dentro do request. */
const DETECT_TIMEOUT_MS = 45_000;

/**
 * Aviso "janela sobre preço" (tarefa 4.7, spec "Janela sobre preço"): para a
 * arte que fala, pergunta ao Gemini (visão) onde estão os PREÇOS da arte de
 * fundo, guarda as caixas no `metadata.priceDetections` do asset da arte
 * (cache por arte: a arte é imutável, e o modelo/versão entram na chave) e
 * compara com a janela do roteiro pelo contrato puro `windowCoversPriceWarning`.
 *
 * NUNCA bloqueia e NUNCA lança: visão indisponível, timeout ou resposta
 * ilegível viram `{warnings: [], error}`. `MC_KIT_PROVIDER=mock` (default em
 * dev) não gasta visão: `MC_PRICE_DETECT_MOCK=none|overlap|error` escolhe o
 * cenário determinístico.
 */
@Injectable()
export class McWindowPriceService {
  private readonly logger = new Logger(McWindowPriceService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly gemini: GeminiImageProvider,
    private readonly storage: McStorageService,
  ) {}

  isMock(): boolean {
    return (process.env.MC_KIT_PROVIDER || 'mock') === 'mock';
  }

  /** Modelo efetivo da detecção — compõe a chave do cache (`mock:<cenário>` no mock). */
  detectionModel(): string {
    return this.isMock()
      ? `mock:${parseMockScenario(process.env.MC_PRICE_DETECT_MOCK)}`
      : GEMINI_VISION_MODEL;
  }

  /** `GET /commercials/projects/:id/window-warnings` — projeto do usuário (404/403 como os demais). */
  async checkOwned(userId: string, projectId: string): Promise<McWindowWarningsView> {
    const project = await this.dataSource.getRepository(McProject).findOneBy({ id: projectId });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    if (project.userId !== userId) throw new ForbiddenException();
    return this.check(project);
  }

  async check(project: McProject): Promise<McWindowWarningsView> {
    const base: McWindowWarningsView = { projectId: project.id, warnings: [] };
    if (project.format !== 'talking_art') return { ...base, skipped: 'not_talking_art' };
    if (!project.backgroundArtAssetId) return { ...base, skipped: 'no_art' };
    // modo rosto do logo: a janela É a caixa do logo, ditada pela arte (não há preset a sugerir)
    if (project.script?.logoFace === true) return { ...base, skipped: 'logo_face' };
    try {
      return await this.evaluate(project, base);
    } catch (err) {
      const message = ((err as Error)?.message ?? 'erro desconhecido').slice(0, 200);
      this.logger.warn(
        `Aviso de preço do projeto ${project.id} indisponível (${message}) — sem avisos.`,
      );
      return { ...base, error: message, model: this.detectionModel() };
    }
  }

  private async evaluate(
    project: McProject,
    base: McWindowWarningsView,
  ): Promise<McWindowWarningsView> {
    const frame = compositionDimensions(project.aspectRatio);
    const art = await this.dataSource
      .getRepository(AnimationAsset)
      .findOneBy({ id: project.backgroundArtAssetId as string });
    if (!art?.fileUrl) return { ...base, skipped: 'no_art' };

    const tile = await this.tileDims(project.kitId);
    const tileRatio = tileRatioOf(tile.width, tile.height);
    const script = project.script;
    const window = isWindowWellFormed(script?.window)
      ? (script!.window as McCharacterWindow)
      : defaultCharacterWindow({
          width: frame.width,
          height: frame.height,
          tileWidth: tile.width,
          tileHeight: tile.height,
        });

    const { cache, cached, artBuffer } = await this.detections(art);
    const artDims = await this.artDims(art, artBuffer);
    const outDetections = detectionsToOutputFrame(cache.detections, artDims, frame);
    const presets = listWindowPresets(frame.width, frame.height, tileRatio);
    const warning = windowCoversPriceWarning(outDetections, window, presets);
    const warnings: McWindowPriceWarningView[] = warning
      ? warning.covered.map((d) => ({
          code: 'WINDOW_COVERS_PRICE' as const,
          box: d.bbox,
          text: d.text,
          message: warning.message,
          suggestedPresetIds: warning.suggestedPresetIds,
        }))
      : [];
    return {
      ...base,
      warnings,
      window,
      frame: { width: frame.width, height: frame.height },
      detections: cache.detections.filter((d) => d.kind === 'price').length,
      cached,
      model: cache.model,
      at: cache.at,
      ...(cache.model.startsWith('mock:') ? { mock: true as const } : {}),
    };
  }

  /** Dimensões do tile do kit (aspecto da janela default); ausentes → default 3:4. */
  private async tileDims(kitId: string): Promise<{ width: number | null; height: number | null }> {
    const kit = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id: kitId });
    if (!kit?.tileAssetId) return { width: null, height: null };
    const tile = await this.dataSource
      .getRepository(AnimationAsset)
      .findOneBy({ id: kit.tileAssetId });
    return { width: tile?.width ?? null, height: tile?.height ?? null };
  }

  /**
   * Detecções da arte (frações da ARTE): cache do asset quando a versão do
   * contrato e o modelo batem; senão detecta (mock ou visão, com teto de
   * tempo) e grava o cache por merge JSONB (não pisa outras chaves do metadata).
   */
  private async detections(art: AnimationAsset): Promise<{
    cache: McPriceDetectionsCache;
    cached: boolean;
    artBuffer: Buffer | null;
  }> {
    const model = this.detectionModel();
    const existing = (art.metadata ?? {}).priceDetections as McPriceDetectionsCache | undefined;
    if (
      existing &&
      existing.version === MC_PRICE_DETECT_VERSION &&
      existing.model === model &&
      Array.isArray(existing.detections)
    ) {
      return { cache: existing, cached: true, artBuffer: null };
    }
    const buffer = await this.storage.readUploadsFile(art.fileUrl as string);
    if (!buffer) throw new Error('arquivo da arte ausente no disco');
    const detections = await this.withTimeout(this.detect(buffer));
    const cache: McPriceDetectionsCache = {
      version: MC_PRICE_DETECT_VERSION,
      model,
      at: new Date().toISOString(),
      detections,
    };
    try {
      await this.dataSource.query(
        `UPDATE animation_assets
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('priceDetections', $2::jsonb)
          WHERE id = $1`,
        [art.id, JSON.stringify(cache)],
      );
    } catch (err) {
      // cache é otimização: a detecção desta chamada vale mesmo sem gravar
      this.logger.warn(`Cache de preços da arte ${art.id} não gravado: ${(err as Error).message}`);
    }
    return { cache, cached: false, artBuffer: buffer };
  }

  private async detect(buffer: Buffer): Promise<McArtTextDetection[]> {
    const image = await sharp(buffer)
      .resize({
        width: ART_MAX_SIDE,
        height: ART_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    if (this.isMock()) {
      const scenario = parseMockScenario(process.env.MC_PRICE_DETECT_MOCK);
      if (scenario === 'error') throw new Error('detecção de preço indisponível (mock)');
      return mockPriceDetections(scenario);
    }
    const text = await this.gemini.describeImages({
      prompt: MC_PRICE_DETECT_PROMPT,
      images: [image],
      mimeType: 'image/png',
    });
    const parsed = parsePriceDetectResponse(text);
    if (!parsed) throw new Error(`resposta não interpretável: ${text.slice(0, 80)}`);
    return parsed;
  }

  private async artDims(
    art: AnimationAsset,
    buffer: Buffer | null,
  ): Promise<{ width: number; height: number }> {
    if (art.width && art.height) return { width: art.width, height: art.height };
    const source = buffer ?? (await this.storage.readUploadsFile(art.fileUrl as string));
    const meta = source ? await sharp(source).metadata() : null;
    if (!meta?.width || !meta?.height) throw new Error('dimensões da arte desconhecidas');
    return { width: meta.width, height: meta.height };
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`detecção de preço excedeu ${DETECT_TIMEOUT_MS / 1000}s`)),
            DETECT_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
