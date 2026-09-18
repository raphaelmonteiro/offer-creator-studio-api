import { McSceneType, McStepType } from './mc-types';

/**
 * Contratos do pipeline v2 (ADR-001 §4): tudo que o projeto persiste ALÉM do
 * roteiro para sustentar preparação revisável, aprovação imutável, orçamento
 * por fase e timeline renderizada. Vive em `mc_projects.quality` (jsonb) —
 * NULL nos projetos legados (pipelineVersion 1), que nunca leem este bloco.
 *
 * Tipos puros: sem Nest/TypeORM, testáveis no domain.
 */

/** Executor legado (por diálogo, aprovação única no storyboard). */
export const MC_PIPELINE_LEGACY = 1;
/** Executor novo (tipos de cena, preparação → revisão visual → produção). */
export const MC_PIPELINE_V2 = 2;

/** `script.schemaVersion` do roteiro novo — independente de `script.version` (editorial). */
export const MC_SCRIPT_SCHEMA_V2 = 2;

export type McPipelineVersion = typeof MC_PIPELINE_LEGACY | typeof MC_PIPELINE_V2;

/** Fase do pipeline v2 — unidade de cotação/reserva e de retomada após falha. */
export type McPhase = 'preparation' | 'production' | 'assembly';

/** Idioma efetivamente enviado ao motor (ADR §3.2: fallback PT é explícito e registrado). */
export type McPromptLang = 'en' | 'pt';

/** Papel de uma referência do kit na requisição (ADR §3.4). */
export type McReferenceRole =
  | 'identity'
  | 'angle'
  | 'expression'
  | 'interaction'
  | 'environment'
  | 'product';

export interface McSelectedReference {
  /** Id do asset do kit/cenário, ou `product:<url>` para a foto do produto. */
  assetId: string;
  /** URL em /uploads/* quando a referência não é um AnimationAsset (foto do produto). */
  fileUrl?: string | null;
  role: McReferenceRole;
  /** Slot do grid do kit (0..3) quando a referência vem do kit; null para cenário/original. */
  slot: number | null;
  /** Motivo curto e auditável da seleção. */
  reason: string;
}

/** Item cotado de uma fase: um step lógico de uma cena (ou do projeto) e seu preço de tabela. */
export interface McQuoteItem {
  sceneId: string | null;
  stepType: McStepType;
  attempt: number;
  credits: number;
  /** true = reaproveitado do cache — entra na cotação com 0 e não gera linha de geração. */
  cached: boolean;
}

export interface McPhaseQuote {
  phase: McPhase;
  revision: number;
  items: McQuoteItem[];
  /** Preço fechado da fase = soma dos itens não cacheados. */
  totalCredits: number;
}

/** Orçamento persistido por fase/revisão (ADR §4.3): cotação ≠ reserva ≠ consumo. */
export interface McPhaseBudget {
  phase: McPhase;
  revision: number;
  quotedCredits: number;
  reservedCredits: number;
  consumedCredits: number;
  refundedCredits: number;
  /** Chave usada no ledger (taskId) — idempotência de reserva/estorno por fase. */
  ledgerKey: string;
  settledAt: string | null;
  items: McQuoteItem[];
}

/** Uma cena dentro do manifesto de preparação: o que foi escolhido e medido. */
export interface McPreparationScene {
  sceneId: string;
  sceneType: McSceneType;
  keyframeAssetId: string | null;
  audioAssetId: string | null;
  /** Duração MEDIDA (probe) do áudio aprovado; null sem fala. */
  audioDurationMs: number | null;
  /** Duração planejada da cena no roteiro (segundos). */
  plannedDurationS: number;
  keyframeHash: string;
  ttsHash: string | null;
  /** Idioma/prompt efetivamente enviados ao gerador de imagem. */
  promptLang: McPromptLang;
  initialFramePrompt: string;
  motionPrompt: string;
  references: McSelectedReference[];
  environmentId: string | null;
  environmentVersion: number | null;
  productRef: string | null;
}

/** Manifesto de preparação de UMA revisão (ADR §4): base do hash que a aprovação assina. */
export interface McPreparationManifest {
  revision: number;
  kitId: string;
  kitVersion: number;
  aspectRatio: string;
  scenes: McPreparationScene[];
  startedAt: string;
  completedAt: string | null;
  /** sha256 do conteúdo acima quando completo (assets selecionados + hashes + durações). */
  hash: string | null;
}

export type McApprovalScope = 'production' | 'assembly_only';

/** Manifesto de aprovação IMUTÁVEL: o que o usuário viu e autorizou (ADR §3.3/§4.1). */
export interface McApprovalManifest {
  scope: McApprovalScope;
  revision: number;
  manifestHash: string;
  approvedAt: string;
  userId: string;
  /** Orçamento aceito para a fase liberada (limite e preço fechado). */
  budgetCredits: number;
}

export interface McTimelineEntry {
  sceneId: string;
  idx: number;
  startS: number;
  endS: number;
  finalAssetId: string;
  /** true quando o áudio da fala não tinha alinhamento e a legenda dessa cena ficou de fora. */
  captionsMissing: boolean;
}

/** Timeline efetivamente renderizada (ADR §3.6): fonte do player/filmstrip após a entrega. */
export interface McRenderedTimeline {
  revision: number;
  version: number;
  totalS: number;
  scenes: McTimelineEntry[];
  endcard: { startS: number; endS: number } | null;
  captionsRequested: boolean;
  /** Cenas faladas cuja legenda solicitada não pôde ser gerada. */
  captionsMissingSceneIds: string[];
  seals: Array<{ sceneId: string; productId: string; startS: number; endS: number }>;
  renderedAt: string;
}

/** Última entrega válida, preservada enquanto uma nova revisão é preparada (ADR §4.1). */
export interface McDeliveryRecord {
  revision: number;
  finalAssetId: string;
  timeline: McRenderedTimeline;
  deliveredAt: string;
}

/**
 * Bloco `mc_projects.quality` — estado do pipeline v2. Campos ausentes valem
 * null/vazio (leitor tolerante: registros criados por versões anteriores do
 * contrato continuam legíveis, ADR §5).
 */
export interface McQualityState {
  /** Fase a retomar após needs_attention/falha (ADR §4.1: nunca presumir generating). */
  resumePhase: McPhase | null;
  /** Escopo pendente de uma revisão aberta a partir de uma entrega (`assembly_only`). */
  pendingScope: McApprovalScope | null;
  preparation: McPreparationManifest | null;
  /** Aprovação corrente da revisão (produção ou remontagem). */
  approval: McApprovalManifest | null;
  /**
   * Última aprovação de PRODUÇÃO válida para as prévias atuais. Sobrevive a
   * revisões `assembly_only` (que não mudam prévias) para que "refazer vídeo"
   * continue autorizado; zerada por qualquer edição que toque prévias.
   */
  productionApproval: McApprovalManifest | null;
  budgets: McPhaseBudget[];
  timeline: McRenderedTimeline | null;
  lastDelivery: McDeliveryRecord | null;
  /** Usuário aceitou entregar sem as legendas ausentes desta revisão. */
  captionsMissingAccepted: boolean;
}

export const MC_EMPTY_QUALITY: McQualityState = {
  resumePhase: null,
  pendingScope: null,
  preparation: null,
  approval: null,
  productionApproval: null,
  budgets: [],
  timeline: null,
  lastDelivery: null,
  captionsMissingAccepted: false,
};

/** Leitor tolerante do jsonb (campos faltando → defaults; nunca lança). */
export function resolveQuality(raw: Partial<McQualityState> | null | undefined): McQualityState {
  return {
    resumePhase: raw?.resumePhase ?? null,
    pendingScope: raw?.pendingScope ?? null,
    preparation: raw?.preparation ?? null,
    approval: raw?.approval ?? null,
    productionApproval: raw?.productionApproval ?? null,
    budgets: Array.isArray(raw?.budgets) ? raw!.budgets : [],
    timeline: raw?.timeline ?? null,
    lastDelivery: raw?.lastDelivery ?? null,
    captionsMissingAccepted: raw?.captionsMissingAccepted === true,
  };
}

export function isPipelineV2(project: { pipelineVersion?: number | null }): boolean {
  return project.pipelineVersion === MC_PIPELINE_V2;
}

/** Chave do ledger de uma fase/revisão — reserva e estorno idempotentes POR FASE (ADR §4.3). */
export function phaseLedgerKey(projectId: string, phase: McPhase, revision: number): string {
  return `${projectId}:${phase}:r${revision}`;
}

export function findPhaseBudget(
  quality: McQualityState,
  phase: McPhase,
  revision: number,
): McPhaseBudget | null {
  return quality.budgets.find((b) => b.phase === phase && b.revision === revision) ?? null;
}

/** Substitui (ou insere) o orçamento de uma fase/revisão — imutável por construção. */
export function upsertPhaseBudget(quality: McQualityState, budget: McPhaseBudget): McQualityState {
  const others = quality.budgets.filter(
    (b) => !(b.phase === budget.phase && b.revision === budget.revision),
  );
  return { ...quality, budgets: [...others, budget] };
}

/** Aprovação válida para a revisão e o escopo pedidos (servidor E worker usam esta regra). */
export function approvalAuthorizes(
  quality: McQualityState | null | undefined,
  revision: number,
  scope: McApprovalScope,
): boolean {
  const approval = quality?.approval ?? null;
  if (!approval || approval.revision !== revision) return false;
  if (approval.scope === scope) return true;
  // Revisão `assembly_only` aprovada: as prévias são as mesmas da produção
  // aprovada antes, então refazer vídeo/rodar produção continua autorizado.
  return (
    scope === 'production' && approval.scope === 'assembly_only' && !!quality?.productionApproval
  );
}
