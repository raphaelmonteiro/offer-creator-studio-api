import { createHash } from 'crypto';
import { McStepType } from './mc-types';

/**
 * Versão do prompt-builder por tipo de step. Bump invalida o cache daquele
 * tipo (plano-comerciais §6.3): mudou o template de prompt/pipeline de
 * montagem, os hashes antigos deixam de casar — sem varrer nada no banco.
 */
export const MC_BUILDER_VERSIONS: Record<McStepType, number> = {
  [McStepType.SCRIPT]: 1,
  [McStepType.KEYFRAME]: 1,
  [McStepType.VIDEO]: 1,
  [McStepType.TTS]: 1,
  [McStepType.LIPSYNC]: 1,
  [McStepType.ASSEMBLY]: 1,
  [McStepType.SCENE_COMPOSE]: 1,
  [McStepType.TALK]: 1,
  [McStepType.COMPOSE_FFMPEG]: 1,
  [McStepType.FINALIZE]: 1,
};

/**
 * Versões dos builders do PIPELINE V2 (ADR-001 §4.2 "introduzir versões dos
 * builders para separar cache antigo do novo"): os hashes v2 têm forma de
 * input diferente e nunca casam com os legados; a versão separada torna isso
 * explícito e permite bumps independentes por executor.
 */
export const MC_BUILDER_VERSIONS_V2: Record<McStepType, number> = {
  [McStepType.SCRIPT]: 2,
  [McStepType.KEYFRAME]: 2,
  [McStepType.VIDEO]: 2,
  [McStepType.TTS]: 2,
  [McStepType.LIPSYNC]: 2,
  [McStepType.ASSEMBLY]: 2,
  [McStepType.SCENE_COMPOSE]: 1,
  /** Clipe falado a partir do tile (change video-formatos-personagem): só existe no v2. */
  [McStepType.TALK]: 1,
  /**
   * Steps de projeto do F1 (D6): a versão do GRAFO de cada um vive no próprio
   * builder (`MC_COMPOSE_GRAPH_VERSION`, `MC_FINALIZE_GRAPH_VERSION`) e entra
   * no hash junto desta versão — trocar o stub pelo grafo real (4.4/4.5) é um
   * bump lá, que invalida o cache sem varrer o banco.
   */
  [McStepType.COMPOSE_FFMPEG]: 1,
  [McStepType.FINALIZE]: 1,
};

/**
 * Serialização canônica (generalização do tts-cache-key):
 * - chaves de objeto ordenadas, recursivamente (ordem de inserção não importa);
 * - strings com espaços normalizados (trim + colapso), case PRESERVADO
 *   (case muda entonação/prompt);
 * - `undefined` em objeto some (mesma semântica do JSON.stringify) e em array
 *   vira null;
 * - arrays preservam ordem (ordem de cenas/refs é semântica).
 */
function canonicalize(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ');
  if (Array.isArray(value)) return value.map((item) => canonicalize(item) ?? null);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        if (source[key] !== undefined) acc[key] = canonicalize(source[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * input_hash de mc_steps (plano-comerciais §6.3):
 * `sha256(tipo + versão do prompt-builder + inputs canônicos)`.
 * Inputs devem incluir os hashes/ids dos assets de entrada — quem monta o
 * objeto é o chamador; aqui só se garante determinismo da serialização.
 * Lookup de cache é escopado por usuário (fica no service, não aqui).
 */
export function computeInputHash(
  type: McStepType | string,
  builderVersion: number,
  inputs: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(canonicalize(inputs));
  return createHash('sha256').update(`${type} v${builderVersion} ${canonical}`).digest('hex');
}

/** sha256 de um objeto canônico qualquer (manifestos, timelines) — mesma serialização. */
export function computeContentHash(value: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}
