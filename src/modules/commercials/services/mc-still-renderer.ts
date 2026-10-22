import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as sharp from 'sharp';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { buildMockStillPlan, OfferPieceStillProps } from '../domain/mc-piece-still-props';
import {
  mcCarouselRendererKind,
  mcCompositionVersion,
  McCarouselRendererKind,
  mcRenderTimeouts,
  MC_OFFER_PIECE_STILL_COMPOSITION_ID,
} from '../domain/mc-render.config';
import {
  McCarouselRendererService,
  RemotionCarouselRenderer,
  VideoTemplatesCoreModule,
} from './mc-carousel-renderer';

/**
 * Quadro PARADO da peça de ofertas (change video-peca-configuravel, 6.2) atrás
 * de uma interface, no mesmo desenho do render do F2:
 *
 * - `RemotionStillRenderer` — `renderStill` do Remotion sobre a composição
 *   `OfferPieceStill` do pacote `@chroma/video-templates`, com o BUNDLE e o
 *   NAVEGADOR já abertos pelo `RemotionCarouselRenderer` deste processo (um
 *   navegador por worker); as mídias chegam por URL absoluta
 *   (`MC_RENDER_ASSET_BASE_URL`). Pacote sem a composição → `RENDER_UNAVAILABLE`.
 * - `MockStillRenderer` — `MC_PIPELINE_PROVIDER=mock` (ou
 *   `MC_CAROUSEL_RENDERER=mock`): sharp desenha fundo + retângulos pelo plano
 *   puro `buildMockStillPlan`, um PNG real do tamanho do formato para o e2e.
 */

export interface McStillRenderRequest {
  props: OfferPieceStillProps;
  /** Arquivo local de cada URL absoluta de mídia das props (o mock lê do disco). */
  localFiles: Record<string, string>;
  /** PNG de saída (tamanho do formato). */
  outputPath: string;
}

export interface McStillRenderResult {
  outputPath: string;
  renderer: McCarouselRendererKind;
  compositionVersion: string;
}

export interface McStillRenderer {
  readonly kind: McCarouselRendererKind;
  compositionVersion(): Promise<string>;
  renderStill(request: McStillRenderRequest): Promise<McStillRenderResult>;
}

const RENDER_UNAVAILABLE = 'RENDER_UNAVAILABLE';

// ───────────────────────────── Remotion ─────────────────────────────

export class RemotionStillRenderer implements McStillRenderer {
  readonly kind = 'remotion' as const;
  private readonly logger = new Logger(RemotionStillRenderer.name);

  constructor(
    private readonly carousel: RemotionCarouselRenderer,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  compositionVersion(): Promise<string> {
    return this.carousel.compositionVersion();
  }

  private validateWithPackage(core: VideoTemplatesCoreModule, props: OfferPieceStillProps): void {
    if (!core.parseOfferPieceStillProps) return;
    const parsed = core.parseOfferPieceStillProps(props);
    if (!parsed.success) {
      const issues = (parsed as { issues?: unknown[] }).issues ?? [];
      throw new TerminalProviderError(
        `Props do quadro recusadas pelo pacote: ${JSON.stringify(issues).slice(0, 400)}`,
        'PIECE_STILL_PROPS_INVALID',
      );
    }
  }

  async renderStill(request: McStillRenderRequest): Promise<McStillRenderResult> {
    const { modules, serveUrl, browser } = await this.carousel.runtime();
    this.validateWithPackage(modules.core, request.props);
    const compositionVersion = modules.core.COMPOSITION_VERSION ?? mcCompositionVersion(this.env);
    const id = modules.core.OFFER_PIECE_STILL_COMPOSITION_ID ?? MC_OFFER_PIECE_STILL_COMPOSITION_ID;
    const { delayRenderTimeoutMs } = mcRenderTimeouts();
    try {
      const composition = await modules.renderer.selectComposition({
        serveUrl,
        id,
        inputProps: request.props,
        puppeteerInstance: browser,
        browserExecutable: this.env.MC_RENDER_BROWSER,
        timeoutInMilliseconds: delayRenderTimeoutMs,
      });
      await modules.renderer.renderStill({
        composition,
        serveUrl,
        output: request.outputPath,
        inputProps: request.props,
        imageFormat: 'png',
        frame: 0,
        puppeteerInstance: browser,
        browserExecutable: this.env.MC_RENDER_BROWSER,
        timeoutInMilliseconds: delayRenderTimeoutMs,
      });
    } catch (err) {
      await this.carousel.discardBrowser();
      const message = (err as Error)?.message ?? String(err);
      // composição ausente no pacote instalado: terminal, como o pacote ausente
      if (/composition|not found|does not exist/i.test(message) && message.includes(id)) {
        throw new TerminalProviderError(
          `Composição "${id}" ausente no pacote de templates: ${message.slice(0, 300)}`,
          RENDER_UNAVAILABLE,
        );
      }
      throw err;
    }
    this.logger.log(`Quadro da peça renderizado (${id}, composição ${compositionVersion})`);
    return { outputPath: request.outputPath, renderer: this.kind, compositionVersion };
  }
}

// ───────────────────────────── mock (sharp) ─────────────────────────────

export class MockStillRenderer implements McStillRenderer {
  readonly kind = 'mock' as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  compositionVersion(): Promise<string> {
    return Promise.resolve(mcCompositionVersion(this.env));
  }

  async renderStill(request: McStillRenderRequest): Promise<McStillRenderResult> {
    const plan = buildMockStillPlan(request.props);
    const { width, height } = plan;
    let base: sharp.Sharp;
    if (plan.backgroundImage) {
      const local = request.localFiles[plan.backgroundImage.url];
      const exists = local
        ? await fs
            .stat(local)
            .then((st) => st.size > 0)
            .catch(() => false)
        : false;
      if (exists) {
        let image = sharp(local as string).resize(width, height, {
          fit: plan.backgroundImage.fit,
          background: '#111827',
        });
        if (plan.backgroundImage.blur > 0) image = image.blur(1 + plan.backgroundImage.blur * 24);
        if (plan.backgroundImage.darken > 0) {
          image = image.modulate({ brightness: Math.max(0.05, 1 - plan.backgroundImage.darken) });
        }
        base = sharp(await image.png().toBuffer());
      } else {
        // sem o arquivo: quadro escuro no lugar da foto (o mock nunca falha por mídia ausente)
        base = sharp({
          create: { width, height, channels: 4, background: '#374151' },
        });
      }
    } else {
      base = sharp(Buffer.from(plan.backgroundSvg as string));
    }
    await base
      .composite([{ input: Buffer.from(plan.overlaySvg), top: 0, left: 0 }])
      .png()
      .toFile(request.outputPath);
    return {
      outputPath: request.outputPath,
      renderer: this.kind,
      compositionVersion: mcCompositionVersion(this.env),
    };
  }
}

// ───────────────────────────── seleção ─────────────────────────────

/** Mesmo critério do render do F2 (`mcCarouselRendererKind`): um renderizador por processo. */
@Injectable()
export class McStillRendererService {
  private remotion: RemotionStillRenderer | null = null;
  private mock: MockStillRenderer | null = null;

  constructor(private readonly carousel: McCarouselRendererService) {}

  current(env: NodeJS.ProcessEnv = process.env): McStillRenderer {
    if (mcCarouselRendererKind(env) === 'mock') {
      this.mock = this.mock ?? new MockStillRenderer(env);
      return this.mock;
    }
    this.remotion =
      this.remotion ?? new RemotionStillRenderer(this.carousel.remotionRenderer(env), env);
    return this.remotion;
  }
}
