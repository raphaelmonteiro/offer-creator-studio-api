import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { mcExpireForQueue } from './mc-pipeline.config';

/**
 * Configuração do render da composição Remotion do F2 (change
 * video-formatos-personagem, tarefa 6.5; design D3/D3b) — funções puras lidas
 * do env a cada chamada (baratas e testáveis), no mesmo papel do
 * mc-pipeline.config para as filas.
 *
 * - `MC_COMPOSITION_VERSION` (default `0.1.0`): versão da composição
 *   `OfferCarousel` do pacote `@chroma/video-templates`. Entra no hash do
 *   render (spec "Render determinístico"): trocar o pacote invalida o render.
 * - `MC_RENDER_ASSET_BASE_URL` (default `http://127.0.0.1:3001`): base das
 *   URLs absolutas de mídia que o navegador do render busca (`/uploads/*` do
 *   backend; no worker da VM a API responde em 127.0.0.1:3001).
 * - `MC_CAROUSEL_RENDERER` (`remotion` | `mock`): força o renderizador; sem
 *   ele, `MC_PIPELINE_PROVIDER=mock` usa o mock em ffmpeg e o resto, o Remotion.
 */
export const MC_DEFAULT_COMPOSITION_VERSION = '0.1.0';
export const MC_DEFAULT_RENDER_ASSET_BASE_URL = 'http://127.0.0.1:3001';

/** Id da composição registrada no Root do pacote (`OFFER_CAROUSEL_COMPOSITION_ID`). */
export const MC_OFFER_CAROUSEL_COMPOSITION_ID = 'OfferCarousel';

export type McCarouselRendererKind = 'remotion' | 'mock';

export function mcCompositionVersion(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MC_COMPOSITION_VERSION ?? '').trim() || MC_DEFAULT_COMPOSITION_VERSION;
}

export function mcRenderAssetBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.MC_RENDER_ASSET_BASE_URL ?? '').trim() || MC_DEFAULT_RENDER_ASSET_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/** Renderizador do F2: override explícito, senão mock com o pipeline mock, senão Remotion. */
export function mcCarouselRendererKind(
  env: NodeJS.ProcessEnv = process.env,
): McCarouselRendererKind {
  const forced = (env.MC_CAROUSEL_RENDERER ?? '').trim().toLowerCase();
  if (forced === 'remotion' || forced === 'mock') return forced;
  return (env.MC_PIPELINE_PROVIDER || 'mock') === 'mock' ? 'mock' : 'remotion';
}

/**
 * Prazos do render (design D6: "`renderMedia({concurrency: 1,
 * timeoutInMilliseconds})` abaixo da expiração para falhar por `failStep` e
 * não ficar órfão"):
 * - `delayRenderTimeoutMs`: o `timeoutInMilliseconds` do Remotion (prazo de
 *   cada `delayRender` — carregar vídeo/fonte/imagem de um quadro);
 * - `totalTimeoutMs`: teto do render INTEIRO (cancelamento por
 *   `makeCancelSignal`), 60 s abaixo da expiração da fila `mc.render`.
 */
export function mcRenderTimeouts(): { delayRenderTimeoutMs: number; totalTimeoutMs: number } {
  const expiryMs = mcExpireForQueue(QUEUES.MC_RENDER) * 1000;
  return {
    delayRenderTimeoutMs: Math.min(120_000, Math.floor(expiryMs / 4)),
    totalTimeoutMs: Math.max(60_000, expiryMs - 60_000),
  };
}
