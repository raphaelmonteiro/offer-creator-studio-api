import { projectAssemblySteps, scenePlan } from './mc-execution-plan';
import { McPhase, McPhaseQuote, McQuoteItem } from './mc-quality';
import { McProjectFormat, McSceneType, McScript, McScriptScene, McStepType } from './mc-types';

/**
 * Tabela de créditos por tipo de step (plano-comerciais §8).
 * 1 crédito = R$ 0,10. Nunca hardcodar custos nos services — este arquivo é a
 * fonte única, revisável sem tocar em lógica (mesmo papel do pricing.config
 * do módulo de animações).
 *
 * Decomposição dos preços do plano §8:
 * - cena sem fala  ~90 cr = keyframe 1 + video 89
 * - cena falada   ~150 cr = keyframe 1 + video 89 + tts 4 + lipsync 56
 * - script e assembly (montagem/re-montagem/selos/legendas) são inclusos (0).
 *
 * CALIBRAÇÃO: estes valores são a tabela de LANÇAMENTO do plano; a calibração
 * final vem da telemetria (`providerCostUsd` real por step, margem alvo
 * 2,5–3×) ANTES do go-live — a tabela antiga do módulo de animações nunca foi
 * calibrada e esse erro não se repete aqui (plano §8/§6.7). Os valores do
 * pipeline v2 serão calibrados em P5 (ADR §4.3), não aqui.
 */
export const MC_STEP_CREDITS: Record<McStepType, number> = {
  [McStepType.SCRIPT]: 0,
  [McStepType.KEYFRAME]: 1,
  [McStepType.VIDEO]: 89,
  [McStepType.TTS]: 4,
  [McStepType.LIPSYNC]: 56,
  [McStepType.ASSEMBLY]: 0,
  /** Composição determinística (FFmpeg) — taxa própria cotada; 0 até calibração (P5). */
  [McStepType.SCENE_COMPOSE]: 0,
  /**
   * Clipe falado a partir do tile (change video-formatos-personagem): mesma
   * tabela do lipsync até a calibração por tier — o custo real por segundo e
   * motor fica em `providerCostUsd` (mcUsdPerSecondForModel).
   */
  [McStepType.TALK]: 56,
  /** Composição e finalização determinísticas (ffmpeg) dos formatos novos — inclusas (0), como o assembly. */
  [McStepType.COMPOSE_FFMPEG]: 0,
  [McStepType.FINALIZE]: 0,
  /** Render da composição Remotion do F2 — incluso (0) até a calibração (custo é CPU do worker). */
  [McStepType.RENDER_REMOTION]: 0,
  /** Quadro parado da peça de ofertas — incluso (0), como o render (tarefa 6.7). */
  [McStepType.RENDER_STILL]: 0,
};

/**
 * Trilha instrumental do F1/F2 (ElevenLabs Music, US$ 0,15/min, chamada no
 * `finalize`): 4 cr ≈ R$ 0,40 por entrega com trilha — uma faixa de 25 s custa
 * ~US$ 0,06 no fornecedor. Entra na cotação/reserva só com `musicEnabled`
 * (achado 5 da 3.7: a trilha precisa aparecer no custo antes da produção).
 * O F3 (`assembly`) segue com a trilha inclusa — "F3 não muda nesta change".
 * Calibração em P5, junto da tabela.
 */
export const MC_MUSIC_CREDITS = 4;

/**
 * Créditos de um step de PROJETO da cadeia de entrega: tabela + trilha no
 * `finalize` (F1/F2) quando o projeto pede trilha.
 */
export function projectStepCredits(
  stepType: McStepType,
  opts: { musicEnabled?: boolean } = {},
): number {
  const music = opts.musicEnabled === true && stepType === McStepType.FINALIZE;
  return MC_STEP_CREDITS[stepType] + (music ? MC_MUSIC_CREDITS : 0);
}

/** Itens da cotação para os steps de projeto da entrega (assembly/compose/render/finalize). */
export function projectAssemblyQuoteItems(
  format: McProjectFormat | null | undefined,
  opts: { musicEnabled?: boolean } = {},
): McQuoteItem[] {
  return projectAssemblySteps(format).map((stepType) => ({
    sceneId: null,
    stepType,
    attempt: 1,
    credits: projectStepCredits(stepType, opts),
    cached: false,
  }));
}

/** Kit do mascote (Ativo de Personagem, 1× por mascote): 30 cr = R$ 3 (§8). */
export const MC_KIT_CREDITS = 30;

/**
 * Mini-reserva fixa na criação do projeto (roteiro + keyframes ≈ centavos) —
 * a reserva principal acontece na aprovação do storyboard (plano §6.7).
 * Debitada em createProject quando creditsEnabled('commercials').
 */
export const MC_PROJECT_MINI_RESERVE_CREDITS = 10;

/** Steps que uma cena LEGADA gera: muda = keyframe→video; falada soma tts+lipsync. */
export function stepsDaCena(scene: Pick<McScriptScene, 'dialogue'>): McStepType[] {
  const spoken = scene.dialogue !== null && scene.dialogue !== undefined && scene.dialogue !== '';
  return spoken
    ? [McStepType.KEYFRAME, McStepType.VIDEO, McStepType.TTS, McStepType.LIPSYNC]
    : [McStepType.KEYFRAME, McStepType.VIDEO];
}

/** Custo em créditos de uma cena legada (90 muda / 150 falada, derivado da tabela). */
export function custoDaCena(scene: Pick<McScriptScene, 'dialogue'>): number {
  return stepsDaCena(scene).reduce((sum, type) => sum + MC_STEP_CREDITS[type], 0);
}

/**
 * Custo total do projeto LEGADO a partir do roteiro aprovado — é o valor da
 * reserva principal na aprovação do storyboard (plano §6.7). Script e assembly
 * entram pela tabela (hoje 0 = inclusos no preço das cenas).
 */
export function custoDoProjeto(script: Pick<McScript, 'scenes'>): number {
  const scenesCost = script.scenes.reduce((sum, scene) => sum + custoDaCena(scene), 0);
  return scenesCost + MC_STEP_CREDITS[McStepType.SCRIPT] + MC_STEP_CREDITS[McStepType.ASSEMBLY];
}

// ─────────────────────────────── pipeline v2 ───────────────────────────────

/** Entrada da cotação por cena: tipo + quais steps já estão resolvidos por cache. */
export interface McQuoteSceneInput {
  sceneId: string;
  sceneType: McSceneType;
  /** Steps do plano que NÃO precisam rodar (cache válido / asset aprovado reaproveitado). */
  cached: McStepType[];
  /** Tentativa por step (default 1). */
  attempts?: Partial<Record<McStepType, number>>;
}

/**
 * Cotação de uma FASE pelo grafo executável (ADR §4.3): só os steps realmente
 * necessários entram com preço; reuso de asset já pago entra com 0 e
 * `cached: true` (não é uma segunda linha de geração). Os steps de PROJETO da
 * fase assembly (`assembly` no F3; `compose_ffmpeg` + `finalize` no F1 — D6)
 * entram na fase de produção (e sozinhos na fase `assembly` de uma revisão
 * editorial); `opts.format` escolhe a cadeia (ausente = `scenes`) e
 * `opts.musicEnabled` soma a trilha ao `finalize` do F1/F2.
 */
export function quotePhase(
  phase: McPhase,
  revision: number,
  scenes: McQuoteSceneInput[],
  opts: { format?: McProjectFormat | null; musicEnabled?: boolean } = {},
): McPhaseQuote {
  const items: McQuoteItem[] = [];
  for (const scene of scenes) {
    const plan = scenePlan(scene.sceneType);
    const stepTypes =
      phase === 'preparation' ? plan.preparation : phase === 'production' ? plan.production : [];
    for (const stepType of stepTypes) {
      const cached = scene.cached.includes(stepType);
      items.push({
        sceneId: scene.sceneId,
        stepType,
        attempt: scene.attempts?.[stepType] ?? 1,
        credits: cached ? 0 : MC_STEP_CREDITS[stepType],
        cached,
      });
    }
  }
  if (phase === 'production' || phase === 'assembly') {
    items.push(...projectAssemblyQuoteItems(opts.format, { musicEnabled: opts.musicEnabled }));
  }
  return {
    phase,
    revision,
    items,
    totalCredits: items.reduce((sum, item) => sum + item.credits, 0),
  };
}

/** Preço de uma regeneração explícita de prévia (imagem ou voz) — tentativa nova, orçada à parte (ADR §4.3). */
export function previewRegenerationCredits(stepType: McStepType.KEYFRAME | McStepType.TTS): number {
  return MC_STEP_CREDITS[stepType];
}

/** Custo de tabela do refazer vídeo de uma cena v2 (produção do plano, sem preparação). */
export function custoProducaoDaCena(sceneType: McSceneType): number {
  return scenePlan(sceneType).production.reduce((sum, type) => sum + MC_STEP_CREDITS[type], 0);
}
