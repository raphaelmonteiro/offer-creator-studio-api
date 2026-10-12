import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createRequire } from 'module';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { buildMockCarouselPlan } from '../domain/mc-carousel-mock-graph';
import { carouselPropsIssues, OfferCarouselProps } from '../domain/mc-offer-carousel-props';
import {
  mcCarouselRendererKind,
  mcCompositionVersion,
  McCarouselRendererKind,
  mcRenderTimeouts,
  MC_OFFER_CAROUSEL_COMPOSITION_ID,
} from '../domain/mc-render.config';

/**
 * Renderização da composição `OfferCarousel` do F2 (change
 * video-formatos-personagem, tarefa 6.5) atrás de uma INTERFACE:
 *
 * - `RemotionCarouselRenderer` — o render real: `@remotion/bundler`,
 *   `@remotion/renderer` e `@chroma/video-templates` carregados por `import()`
 *   DINÂMICO no primeiro uso (o backend compila e roda sem eles; ausentes →
 *   erro terminal `RENDER_UNAVAILABLE`). Bundle UMA vez por processo
 *   (`enableCaching: false`), navegador aberto UMA vez com
 *   `MC_RENDER_BROWSER`, `selectComposition` + `renderMedia({concurrency: 1})`
 *   com prazo por `delayRender` e cancelamento total abaixo da expiração da
 *   fila. Props revalidadas com `parseOfferCarouselProps`, `validateLayout` e
 *   `captionsReadiness` do pacote.
 * - `MockCarouselRenderer` — `MC_PIPELINE_PROVIDER=mock`: um MP4 real em
 *   ffmpeg (slides por oferta + personagem na janela + TTS) para o e2e mock.
 *
 * `MC_CAROUSEL_RENDERER=remotion|mock` força um deles (ex.: render real da
 * composição com clipes do pipeline mock, custo zero de fornecedor).
 */

export interface McCarouselRenderRequest {
  props: OfferCarouselProps;
  /** Arquivo local de cada URL de mídia das props (o mock lê do disco; o Remotion busca por http). */
  localFiles: Record<string, string>;
  /** Onde o MP4 renderizado deve ser escrito. */
  outputPath: string;
  tempDir: string;
  onProgress?: (pct: number) => Promise<void> | void;
}

export interface McCarouselRenderResult {
  outputPath: string;
  renderer: McCarouselRendererKind;
  compositionVersion: string;
}

export interface McCarouselRenderer {
  readonly kind: McCarouselRendererKind;
  /** Versão da composição que ESTE renderizador desenha (entra no hash do render). */
  compositionVersion(): Promise<string>;
  render(request: McCarouselRenderRequest): Promise<McCarouselRenderResult>;
  /** Libera navegador/bundle (fim do processo). */
  dispose?(): Promise<void>;
}

const RENDER_UNAVAILABLE = 'RENDER_UNAVAILABLE';

// ───────────────────────────── Remotion ─────────────────────────────

/** Superfície usada do `@remotion/bundler` (tipada à mão: o pacote não é dependência). */
interface RemotionBundlerModule {
  bundle(options: {
    entryPoint: string;
    enableCaching?: boolean;
    onProgress?: (progress: number) => void;
  }): Promise<string>;
}

/** Superfície usada do `@remotion/renderer`. */
interface RemotionRendererModule {
  openBrowser(
    browser: 'chrome',
    options?: { browserExecutable?: string | null; chromiumOptions?: Record<string, unknown> },
  ): Promise<{ close: (opts?: unknown) => Promise<void> }>;
  selectComposition(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  renderMedia(options: Record<string, unknown>): Promise<unknown>;
  makeCancelSignal(): { cancelSignal: unknown; cancel: () => void };
}

/** Superfície usada do núcleo de `@chroma/video-templates/core`. */
interface VideoTemplatesCoreModule {
  COMPOSITION_VERSION?: string;
  OFFER_CAROUSEL_COMPOSITION_ID?: string;
  parseOfferCarouselProps?: (
    input: unknown,
  ) => { success: true; data: unknown } | { success: false; issues: unknown[] };
  validateLayout?: (props: unknown) => Array<{ code: string; message: string; elementId?: string }>;
  captionsReadiness?: (props: unknown) => { ok: boolean; code: string | null; message?: string };
}

export interface RemotionModules {
  bundler: RemotionBundlerModule;
  renderer: RemotionRendererModule;
  core: VideoTemplatesCoreModule;
  /** `src/index.ts` (registerRoot) do pacote — entrada do bundle. */
  entryPoint: string;
}

/**
 * Carrega os módulos do render. Ordem: `MC_VIDEO_TEMPLATES_DIR` (checkout
 * local do pacote — resolve o bundler/renderer a partir do node_modules
 * DELE) e, sem ela, `node_modules/@chroma/video-templates` do backend.
 * Qualquer peça ausente → `RENDER_UNAVAILABLE` (terminal, sem retry).
 */
export async function loadRemotionModules(
  env: NodeJS.ProcessEnv = process.env,
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<RemotionModules> {
  const templatesDir = (env.MC_VIDEO_TEMPLATES_DIR ?? '').trim();
  try {
    let pkgDir: string;
    let resolveFrom: NodeJS.Require;
    if (templatesDir) {
      pkgDir = path.resolve(templatesDir);
      resolveFrom = createRequire(path.join(pkgDir, 'package.json'));
    } else {
      resolveFrom = createRequire(path.join(process.cwd(), 'package.json'));
      pkgDir = path.dirname(resolveFrom.resolve('@chroma/video-templates/package.json'));
    }
    const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8')) as {
      remotionEntry?: string;
    };
    const entryPoint = path.join(pkgDir, pkg.remotionEntry ?? 'src/index.ts');
    const corePath = path.join(pkgDir, 'dist', 'cjs', 'core', 'index.js');
    const [bundler, renderer, core] = await Promise.all([
      importer(resolveFrom.resolve('@remotion/bundler')),
      importer(resolveFrom.resolve('@remotion/renderer')),
      importer(corePath),
    ]);
    return {
      bundler: bundler as RemotionBundlerModule,
      renderer: renderer as RemotionRendererModule,
      core: core as VideoTemplatesCoreModule,
      entryPoint,
    };
  } catch (err) {
    throw new TerminalProviderError(
      'Renderizador da composição indisponível neste worker (@remotion/bundler, ' +
        '@remotion/renderer ou @chroma/video-templates ausentes): ' +
        ((err as Error)?.message ?? String(err)).slice(0, 300),
      RENDER_UNAVAILABLE,
    );
  }
}

export class RemotionCarouselRenderer implements McCarouselRenderer {
  readonly kind = 'remotion' as const;
  private readonly logger = new Logger(RemotionCarouselRenderer.name);
  private modules: Promise<RemotionModules> | null = null;
  private serveUrl: Promise<string> | null = null;
  private browser: Promise<{ close: (opts?: unknown) => Promise<void> }> | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly loader: (env: NodeJS.ProcessEnv) => Promise<RemotionModules> = (e) =>
      loadRemotionModules(e),
  ) {}

  private load(): Promise<RemotionModules> {
    if (!this.modules) {
      this.modules = this.loader(this.env).catch((err) => {
        this.modules = null; // próxima tentativa recarrega (ex.: pacote instalado depois)
        throw err;
      });
    }
    return this.modules;
  }

  async compositionVersion(): Promise<string> {
    const modules = await this.load();
    return modules.core.COMPOSITION_VERSION ?? mcCompositionVersion(this.env);
  }

  /** Bundle UMA vez por processo (D3b: "uma vez por deploy"), sem cache do webpack. */
  private bundle(modules: RemotionModules): Promise<string> {
    if (!this.serveUrl) {
      const started = Date.now();
      this.serveUrl = modules.bundler
        .bundle({ entryPoint: modules.entryPoint, enableCaching: false })
        .then((url) => {
          this.logger.log(`Bundle da composição pronto em ${Date.now() - started} ms`);
          return url;
        })
        .catch((err) => {
          this.serveUrl = null;
          throw err;
        });
    }
    return this.serveUrl;
  }

  /** Navegador reutilizado por processo, sempre o executável do preflight (`MC_RENDER_BROWSER`). */
  private openBrowser(modules: RemotionModules) {
    const executable = (this.env.MC_RENDER_BROWSER ?? '').trim();
    if (!executable) {
      throw new TerminalProviderError(
        'MC_RENDER_BROWSER não definido: o render de "ofertas em sequência" precisa do navegador.',
        RENDER_UNAVAILABLE,
      );
    }
    if (!this.browser) {
      this.browser = modules.renderer
        .openBrowser('chrome', { browserExecutable: executable })
        .catch((err) => {
          this.browser = null;
          throw err;
        });
    }
    return this.browser;
  }

  /** Revalidação com o núcleo do pacote (quando exposto): forma, layout e legendas. */
  private validateWithPackage(core: VideoTemplatesCoreModule, props: OfferCarouselProps): void {
    if (core.parseOfferCarouselProps) {
      const parsed = core.parseOfferCarouselProps(props);
      if (!parsed.success) {
        const issues = (parsed as { issues?: unknown[] }).issues ?? [];
        throw new TerminalProviderError(
          `Props da composição recusadas pelo pacote: ${JSON.stringify(issues).slice(0, 400)}`,
          'CAROUSEL_PROPS_INVALID',
        );
      }
    }
    if (core.validateLayout) {
      const issues = core.validateLayout(props);
      if (issues.length > 0) {
        throw new TerminalProviderError(
          `Layout fora da área segura: ${issues
            .map((i) => `[${i.code}${i.elementId ? `:${i.elementId}` : ''}] ${i.message}`)
            .join(' | ')
            .slice(0, 400)}`,
          'CAROUSEL_LAYOUT_INVALID',
        );
      }
    }
    if (core.captionsReadiness) {
      const readiness = core.captionsReadiness(props);
      if (!readiness.ok) {
        throw new TerminalProviderError(
          readiness.message ?? 'Legendas sem timestamps por palavra',
          readiness.code ?? 'CAPTIONS_ALIGNMENT_MISSING',
        );
      }
    }
  }

  async render(request: McCarouselRenderRequest): Promise<McCarouselRenderResult> {
    const modules = await this.load();
    this.validateWithPackage(modules.core, request.props);
    const compositionVersion = modules.core.COMPOSITION_VERSION ?? mcCompositionVersion(this.env);
    if (compositionVersion !== mcCompositionVersion(this.env)) {
      this.logger.warn(
        `compositionVersion do pacote (${compositionVersion}) difere de MC_COMPOSITION_VERSION ` +
          `(${mcCompositionVersion(this.env)}) — o hash do render usa a do pacote.`,
      );
    }
    const serveUrl = await this.bundle(modules);
    const browser = await this.openBrowser(modules);
    const { delayRenderTimeoutMs, totalTimeoutMs } = mcRenderTimeouts();
    const id = modules.core.OFFER_CAROUSEL_COMPOSITION_ID ?? MC_OFFER_CAROUSEL_COMPOSITION_ID;
    const { cancelSignal, cancel } = modules.renderer.makeCancelSignal();
    const timer = setTimeout(cancel, totalTimeoutMs);
    timer.unref?.();
    try {
      const composition = await modules.renderer.selectComposition({
        serveUrl,
        id,
        inputProps: request.props,
        puppeteerInstance: browser,
        browserExecutable: this.env.MC_RENDER_BROWSER,
        timeoutInMilliseconds: delayRenderTimeoutMs,
      });
      let lastPct = -1;
      await modules.renderer.renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation: request.outputPath,
        inputProps: request.props,
        concurrency: 1,
        puppeteerInstance: browser,
        browserExecutable: this.env.MC_RENDER_BROWSER,
        timeoutInMilliseconds: delayRenderTimeoutMs,
        cancelSignal,
        onProgress: ({ progress }: { progress: number }) => {
          const pct = Math.round(progress * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            void request.onProgress?.(pct);
          }
        },
      });
    } catch (err) {
      // navegador possivelmente morto: o próximo job abre outro
      const dead = this.browser;
      this.browser = null;
      await dead?.then((b) => b.close({ silent: true })).catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return { outputPath: request.outputPath, renderer: this.kind, compositionVersion };
  }

  async dispose(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await browser?.then((b) => b.close({ silent: true })).catch(() => undefined);
  }
}

// ───────────────────────────── mock (ffmpeg) ─────────────────────────────

export class MockCarouselRenderer implements McCarouselRenderer {
  readonly kind = 'mock' as const;

  constructor(
    private readonly ffmpeg: Pick<FfmpegRunner, 'run'>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  compositionVersion(): Promise<string> {
    return Promise.resolve(mcCompositionVersion(this.env));
  }

  async render(request: McCarouselRenderRequest): Promise<McCarouselRenderResult> {
    const issues = carouselPropsIssues(request.props);
    if (issues.length > 0) {
      throw new TerminalProviderError(
        `Layout/props inválidos: ${issues
          .map((i) => i.message)
          .join(' | ')
          .slice(0, 400)}`,
        'CAROUSEL_LAYOUT_INVALID',
      );
    }
    const clipPaths = request.props.character.clips.map((clip) => {
      const local = request.localFiles[clip.src];
      if (!local) {
        throw new TerminalProviderError(
          `Clipe ${clip.lineId ?? clip.src} sem arquivo local para o render mock`,
          'scene_asset_missing',
        );
      }
      return local;
    });
    const plan = buildMockCarouselPlan({
      props: request.props,
      clipPaths,
      tempDir: request.tempDir,
    });
    const totalMs = plan.passes.reduce((sum, p) => sum + p.durationMs, 0) || 1;
    let doneMs = 0;
    for (const pass of plan.passes) {
      const baseMs = doneMs;
      await this.ffmpeg.run(pass.args, {
        durationMs: pass.durationMs,
        timeoutMs: 300_000,
        onProgress: async (pct) => {
          await request.onProgress?.(((baseMs + (pass.durationMs * pct) / 100) / totalMs) * 100);
        },
      });
      doneMs += pass.durationMs;
    }
    // saída e intermediários no mesmo tempdir do job: rename (nunca copyFile no bind mount)
    if (plan.output !== request.outputPath) await fs.rename(plan.output, request.outputPath);
    return {
      outputPath: request.outputPath,
      renderer: this.kind,
      compositionVersion: mcCompositionVersion(this.env),
    };
  }
}

// ───────────────────────────── seleção ─────────────────────────────

/**
 * Escolhe o renderizador pelo env (`mcCarouselRendererKind`) e mantém UMA
 * instância de cada por processo (bundle e navegador reaproveitados).
 */
@Injectable()
export class McCarouselRendererService implements OnModuleDestroy {
  private remotion: RemotionCarouselRenderer | null = null;
  private mock: MockCarouselRenderer | null = null;

  constructor(private readonly ffmpeg: FfmpegRunner) {}

  current(env: NodeJS.ProcessEnv = process.env): McCarouselRenderer {
    if (mcCarouselRendererKind(env) === 'mock') {
      this.mock = this.mock ?? new MockCarouselRenderer(this.ffmpeg, env);
      return this.mock;
    }
    this.remotion = this.remotion ?? new RemotionCarouselRenderer(env);
    return this.remotion;
  }

  async onModuleDestroy(): Promise<void> {
    await this.remotion?.dispose();
  }
}
