import { McStepType } from './mc-types';

/**
 * Motor e resolução de um clipe de cena na visão do projeto (tarefa 7.2,
 * `GET /commercials/projects/:id`): a UI e a auditoria leem, por cena e por
 * step, QUAL motor gerou o clipe e em que resolução ele chegou à composição
 * — sem abrir o asset. Função PURA sobre o asset publicado pelo ingest
 * (`metadata.engine`, `metadata.resolution`, `metadata.premiumResolutionOk`)
 * e, antes do ingest, sobre o snapshot do step (`effectiveEngine`/`engine`).
 */

/** Resolução do clipe na visão: medidas do arquivo + veredito do premium (null = não se aplica). */
export interface McClipResolutionView {
  width: number | null;
  height: number | null;
  /** true/false só quando a garantia de 1080 px do premium se aplica; null nos demais. */
  premiumResolutionOk: boolean | null;
}

export interface McClipView {
  /** Modelo (fal) que gerou o clipe; null quando o step/asset não é um clipe de provider. */
  engine: string | null;
  resolution: McClipResolutionView | null;
}

/** Recorte do asset que a visão consome (o `resolveAssetUrls` do service carrega estes campos). */
export interface McClipAssetLike {
  kind?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  metadata?: Record<string, unknown> | null;
}

/** Recorte do step que a visão consome. */
export interface McClipStepLike {
  type: string;
  provider?: string | null;
  inputSnapshot?: Record<string, unknown> | null;
}

/** Steps cujo produto é um clipe gerado por motor de vídeo (fal). */
const CLIP_STEP_TYPES: readonly string[] = [McStepType.TALK, McStepType.LIPSYNC, McStepType.VIDEO];

/** Assets de clipe de cena publicados pelo ingest. */
const CLIP_ASSET_KINDS: readonly string[] = ['scene_synced', 'scene_clip'];

/** Provedores que não são motores de vídeo (montagem local e mock). */
const NON_ENGINE_PROVIDERS: readonly string[] = ['ffmpeg', 'mock', 'tts', 'elevenlabs'];

const EMPTY: McClipView = { engine: null, resolution: null };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function modelOf(value: unknown): string | null {
  return value && typeof value === 'object' ? text((value as { model?: unknown }).model) : null;
}

function isClipAsset(asset: McClipAssetLike | null | undefined): asset is McClipAssetLike {
  if (!asset) return false;
  if (asset.kind && CLIP_ASSET_KINDS.includes(asset.kind)) return true;
  return !asset.kind && (asset.mimeType ?? '').startsWith('video/');
}

function resolutionOf(asset: McClipAssetLike): McClipResolutionView {
  const metadata = asset.metadata ?? {};
  const ok = metadata.premiumResolutionOk;
  return {
    width: asset.width ?? null,
    height: asset.height ?? null,
    premiumResolutionOk: typeof ok === 'boolean' ? ok : null,
  };
}

/**
 * Visão do clipe de uma CENA (asset final da cena). Motor = `metadata.engine.model`
 * (talk), senão `metadata.provider` quando é um motor real (lipsync/vídeo legado).
 */
export function sceneClipView(asset: McClipAssetLike | null | undefined): McClipView {
  if (!isClipAsset(asset)) return EMPTY;
  const metadata = asset.metadata ?? {};
  const provider = text(metadata.provider);
  const engine =
    modelOf(metadata.engine) ??
    (provider && !NON_ENGINE_PROVIDERS.includes(provider) ? provider : null);
  return { engine, resolution: resolutionOf(asset) };
}

/**
 * Visão do clipe de um STEP de motor (talk/lipsync/video): o asset de saída
 * prevalece; antes do ingest, o motor EFETIVO do snapshot (o que recebeu o
 * submit), depois o `provider` gravado, depois o motor planejado.
 */
export function stepClipView(
  step: McClipStepLike,
  outputAsset: McClipAssetLike | null | undefined,
): McClipView {
  if (!CLIP_STEP_TYPES.includes(step.type)) return EMPTY;
  const fromAsset = sceneClipView(outputAsset);
  const snapshot = step.inputSnapshot ?? {};
  const provider = text(step.provider);
  const engine =
    fromAsset.engine ??
    modelOf(snapshot.effectiveEngine) ??
    (provider && !NON_ENGINE_PROVIDERS.includes(provider) ? provider : null) ??
    modelOf(snapshot.engine);
  return { engine, resolution: fromAsset.resolution };
}
