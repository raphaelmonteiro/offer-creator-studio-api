/**
 * Vocabulário central do módulo de comerciais (plano-comerciais §6.1).
 * Tipos puros compartilhados por entidades, scheduler, pricing e processors —
 * sem dependência de Nest/TypeORM para manter o domain 100% testável.
 */

/** Tipos de step — a unidade de execução/custo/cache (plano §6.1 mc_steps). */
export enum McStepType {
  SCRIPT = 'script',
  KEYFRAME = 'keyframe',
  VIDEO = 'video',
  TTS = 'tts',
  LIPSYNC = 'lipsync',
  /** Pipeline v2 (ADR-001 §3.1): vídeo de ação + TTS → clipe final da cena (FFmpeg). */
  SCENE_COMPOSE = 'scene_compose',
  ASSEMBLY = 'assembly',
}

/**
 * Aspectos de saída do comercial. `'4:5'` (feed) entrou com a change
 * video-formatos-personagem (design D12) para os formatos novos (F1/F2, que
 * montam em 1080p via `compositionDimensions`); o formato `scenes` (F3) monta
 * em 720p (`assemblyDimensions`) e NÃO o aceita — ver `MC_SCENES_ASPECT_RATIOS`.
 * A ordem é só de apresentação; nenhum código depende do índice.
 */
export const MC_ASPECT_RATIOS = ['9:16', '4:5', '1:1', '16:9'] as const;
export type McAspectRatio = (typeof MC_ASPECT_RATIOS)[number];

/**
 * Subconjunto aceito pelo formato `scenes` (F3): keyframe, motores de vídeo e
 * montagem 720p só conhecem 9:16 · 1:1 · 16:9. A admissão recusa 4:5 com
 * 422 ASPECT_NOT_SUPPORTED_FOR_FORMAT (`assertAspectSupportedForFormat`).
 */
export const MC_SCENES_ASPECT_RATIOS = [
  '9:16',
  '1:1',
  '16:9',
] as const satisfies readonly McAspectRatio[];
export type McScenesAspectRatio = (typeof MC_SCENES_ASPECT_RATIOS)[number];

export function isScenesAspectRatio(
  aspectRatio: string | null | undefined,
): aspectRatio is McScenesAspectRatio {
  return (MC_SCENES_ASPECT_RATIOS as readonly string[]).includes(aspectRatio ?? '');
}

/**
 * Formatos de projeto (change video-formatos-personagem, design D6):
 * - scenes: comercial de cenas geradas (F3, o formato original; v1 e v2);
 * - talking_art: arte estática do Chroma + personagem falando numa janela (F1);
 * - offer_carousel: personagem apresentador + cards de oferta sincronizados (F2).
 * A admissão dos formatos novos é por configuração (`MC_FORMATS`, mc-pipeline.config).
 */
export const MC_PROJECT_FORMATS = ['scenes', 'talking_art', 'offer_carousel'] as const;
export type McProjectFormat = (typeof MC_PROJECT_FORMATS)[number];
export const MC_DEFAULT_PROJECT_FORMAT: McProjectFormat = 'scenes';

/**
 * Tier do projeto (design D2/D6): decide o motor de fala dos formatos novos
 * (`economico` = Kling Avatar standard, `premium` = motor 1080p nativo). No
 * formato `scenes` é só rótulo (`economico`), sem troca de motor.
 */
export const MC_PROJECT_TIERS = ['economico', 'premium'] as const;
export type McProjectTier = (typeof MC_PROJECT_TIERS)[number];
export const MC_DEFAULT_PROJECT_TIER: McProjectTier = 'economico';

/** Canal de entrega (design D13): define perfil de encode e limites de tamanho. NULL = sem perfil. */
export const MC_PROJECT_CHANNELS = ['instagram', 'whatsapp'] as const;
export type McProjectChannel = (typeof MC_PROJECT_CHANNELS)[number];

/**
 * Caixa do logo na arte de origem (design D9b), em FRAÇÕES 0..1 da largura/
 * altura da arte — independe da resolução de saída escolhida.
 */
export interface McLogoBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Origem da arte que virou projeto (design D9): documento do Chroma + página + hash do snapshot. */
export const MC_SOURCE_ART_KINDS = ['flyer', 'social', 'v2_document'] as const;
export type McSourceArtKind = (typeof MC_SOURCE_ART_KINDS)[number];

export interface McSourceArt {
  kind: McSourceArtKind;
  id: string;
  pageIndex: number;
  /** Hash do snapshot rasterizado — muda quando a arte é editada depois da ponte. */
  snapshotHash: string;
}

/**
 * Tipos de cena do pipeline v2 (ADR-001 §3.1) — o TIPO determina o grafo de
 * execução; a presença de diálogo deixa de ser o único critério.
 * - presenter: mascote fala para a câmera → keyframe + TTS → Avatar.
 * - action: ação física sem locução → keyframe → motor de ação.
 * - action_voiceover: ação com narração sobreposta → keyframe → motor de ação;
 *   TTS; ambos → scene_compose. NUNCA Avatar.
 */
export const MC_SCENE_TYPES = ['presenter', 'action', 'action_voiceover'] as const;
export type McSceneType = (typeof MC_SCENE_TYPES)[number];

/** Área livre reservada aos elementos gráficos (selo/legenda) no planejamento da cena. */
export const MC_SAFE_AREAS = ['lower_third', 'left', 'right'] as const;
export type McSafeArea = (typeof MC_SAFE_AREAS)[number];

/** Cenário compartilhado aprovado por grupo de cenas (ADR §3.5), versionado. */
export interface McScriptEnvironment {
  id: string;
  /** Asset visual do cenário (kind `environment_reference`); null enquanto só há descrição. */
  assetId: string | null;
  description: string;
  version: number;
}

/**
 * Derivação em inglês da intenção editada em pt-BR (ADR §3.2): válida SOMENTE
 * quando `sourceHash` bate com o hash atual de (initialFrame, actionPrompt).
 * Editar a intenção invalida a derivação por construção — nada é preservado
 * pela posição da cena.
 */
export interface McSceneDerived {
  sourceHash: string;
  initialFrameEn: string | null;
  actionPromptEn: string | null;
  /** 'pt' = fallback explícito (tradutor indisponível/mock) — registrado, não silencioso. */
  lang: 'en' | 'pt';
  provider: string;
  at: string;
}

/** Intervalo do selo dentro da cena (segundos relativos ao início da cena). */
export interface McSealCue {
  startS: number;
  endS: number;
}

/**
 * Roteiro (mc_projects.script, jsonb) — fonte de verdade do comercial
 * (plano §6.1). `dialogue: null` = cena muda (sem tts/lipsync).
 *
 * McScript v1/v2-legado: `actionPromptEn` carrega a MESMA ação em inglês
 * (preservada por posição pelo updateScript legado). Roteiros do pipeline v2
 * (`schemaVersion: 2`) usam `sceneId` estável, `sceneType`, `initialFrame`
 * separado do movimento (`actionPrompt`), `derived` validada por hash da
 * intenção e `productRef` explícito por cena.
 */
export interface McScriptScene {
  idx: number;
  /** Identidade editorial estável (v2); ausência identifica roteiros legados. */
  sceneId?: string;
  sceneType?: McSceneType;
  /** Estado inicial da imagem (pt-BR) — o keyframe nasce daqui (ADR §3.2). */
  initialFrame?: string;
  camera?: string | null;
  environmentId?: string | null;
  /** Produto anunciado nesta cena (id do snapshot) ou null = cena sem oferta (ADR §3.6). */
  productRef?: string | null;
  sealCue?: McSealCue | null;
  safeArea?: McSafeArea | null;
  /** Ação/movimento da cena em pt-BR — é o que a UI mostra e o usuário edita. */
  actionPrompt: string;
  /** Legado (v1): mesma ação em inglês, preservada por posição. Ignorado no v2. */
  actionPromptEn?: string;
  /** v2: derivação EN validada por `sourceHash` (ver `effectiveScenePrompts`). */
  derived?: McSceneDerived | null;
  dialogue: string | null;
  durationS: number;
}

/**
 * Produto do selo determinístico (plano §5.4): nome + preço prontos, vindos do
 * catálogo. No v2 `id` é a chave estável congelada no snapshot do projeto
 * (ADR §3.6) — nunca a posição na lista; `catalogId` é a origem, quando há.
 */
export interface McSealProduct {
  id?: string;
  catalogId?: string | null;
  unit?: string | null;
  /**
   * Foto REAL do produto (URL em /uploads/*, do catálogo ou da galeria).
   * Entra como referência visual do keyframe da cena que anuncia o produto
   * (ADR §3.4: "a referência de produto participa quando relevante") — é o
   * que faz o mascote segurar a embalagem verdadeira em vez da caixa genérica.
   */
  imageUrl?: string | null;
  name: string;
  price: string;
}

/**
 * Selo determinístico aplicado pelo ffmpeg na montagem (plano §5.4: preço/
 * nome/validade NUNCA passam pelo modelo de vídeo).
 * - v2 (v1-B1): `products` — até 6 produtos, 1 selo por cena (rotativo).
 * - v0/v1 (compat): `text` — um texto único no terço inferior.
 * Os dois convivem: a montagem prefere `products` e cai em `text`.
 * Pipeline v2 NÃO usa rotação: os selos vêm de `scene.productRef`.
 */
export interface McScriptSeal {
  products?: McSealProduct[];
  text?: string;
}

/** Cartela final determinística (2s) com o nome do estabelecimento (plano §5.4). */
export interface McScriptEndcard {
  storeName: string;
}

export interface McScript {
  /** Versão editorial histórica (incrementa a cada edição), independente do schema. */
  version: number;
  /** 2 = roteiro do pipeline v2. Ausente = legado (nunca inferir de `version`). */
  schemaVersion?: number;
  /** v2: snapshot congelado dos produtos anunciados (chave estável `id`). */
  products?: McSealProduct[];
  environments?: McScriptEnvironment[];
  scenes: McScriptScene[];
  /** Selo opcional da montagem (plano §5.4); ausente = vídeo sem selo. Legado. */
  seal?: McScriptSeal | null;
  /** Cartela final opcional — ausente quando o usuário não tem estabelecimento. */
  endcard?: McScriptEndcard | null;
}

/**
 * Opções do projeto (mc_projects.options, jsonb) — decidido como UMA coluna
 * jsonb em vez de 3 colunas novas porque o conjunto é do domínio "preferências
 * de montagem" e tende a crescer (v1.x: SFX, marca d'água), enquanto
 * aspectRatio/targetDurationS continuam colunas próprias por serem chave de
 * hash/roteamento. Projetos antigos têm `options` NULL → defaults abaixo.
 */
export interface McProjectOptions {
  /** Trilha instrumental na montagem (plano §5.1 etapa 6). */
  musicEnabled: boolean;
  /** Legendas queimadas a partir dos timestamps do TTS (plano §5.4). */
  captionsEnabled: boolean;
  /**
   * Faixa DESFOCADA no terço inferior, atrás de selo e legendas (24/09): esconde
   * letreiros que o gerador de vídeo inventa nessa região. Opcional — desfoca
   * também pernas/pés do mascote nesse trecho.
   */
  lowerThirdBlur?: boolean;
  /** Produtos do catálogo que viram selos determinísticos (máx. 6). */
  products: McSealProduct[];
}

export const MC_DEFAULT_PROJECT_OPTIONS: McProjectOptions = {
  musicEnabled: true,
  captionsEnabled: true,
  lowerThirdBlur: false,
  products: [],
};

/** Máximo de produtos com selo em um comercial (plano §5.4 / contrato v1). */
export const MC_MAX_SEAL_PRODUCTS = 6;

/** Options com defaults aplicados — projetos anteriores ao v1-B1 têm a coluna NULL. */
export function resolveProjectOptions(options: Partial<McProjectOptions> | null): McProjectOptions {
  return {
    musicEnabled: options?.musicEnabled ?? MC_DEFAULT_PROJECT_OPTIONS.musicEnabled,
    captionsEnabled: options?.captionsEnabled ?? MC_DEFAULT_PROJECT_OPTIONS.captionsEnabled,
    lowerThirdBlur: options?.lowerThirdBlur ?? false,
    products: (options?.products ?? []).slice(0, MC_MAX_SEAL_PRODUCTS),
  };
}

/**
 * Prompt de ação em INGLÊS de uma cena LEGADA: usa o campo v1 quando existe e
 * cai no pt do roteiro (motor recebe pt — degradação aceita e documentada, é o
 * que a v0 já fazia). O pipeline v2 usa `effectiveScenePrompts` (mc-script-v2).
 */
export function sceneActionPromptEn(
  scene: Partial<Pick<McScriptScene, 'actionPrompt' | 'actionPromptEn'>>,
): string {
  const en = scene.actionPromptEn?.trim();
  if (en && en.length > 0) return en;
  return scene.actionPrompt?.trim() ?? '';
}

/** Produtos do selo, normalizados (compat com o selo de texto único da v0). */
export function sealProducts(seal: McScriptSeal | null | undefined): McSealProduct[] {
  if (!seal) return [];
  if (Array.isArray(seal.products) && seal.products.length > 0) {
    return seal.products.slice(0, MC_MAX_SEAL_PRODUCTS);
  }
  return [];
}
