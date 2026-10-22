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
  /**
   * Change video-formatos-personagem (D6/D7): clipe falado a partir do TILE do
   * kit + áudio da cena, no motor escolhido por tier/origem (fila mc.submit).
   * Nunca passa por keyframe nem por arte de fundo.
   */
  TALK = 'talk',
  ASSEMBLY = 'assembly',
  /**
   * Steps de PROJETO dos formatos novos (change video-formatos-personagem,
   * D6; `sceneId = null`, fase `assembly`, fila mc.ffmpeg), agendados depois
   * do último `talk` no lugar da montagem 720p (`assembly`, só do F3):
   * - compose_ffmpeg (F1): arte de fundo + clipes falados na janela → vídeo composto;
   * - finalize (F1/F2): legendas, trilha com ducking, loudness e perfil do canal → entrega.
   */
  COMPOSE_FFMPEG = 'compose_ffmpeg',
  FINALIZE = 'finalize',
  /**
   * Step de PROJETO do F2 "ofertas em sequência" (tarefa 6.5, D3/D6): renderiza
   * a composição Remotion `OfferCarousel` (cards + personagem + legendas por
   * palavra) a partir das falas conformadas — fila própria `mc.render`
   * (concorrência 1, expiração 900 s) — e entrega o vídeo COMPOSTO ao `finalize`.
   */
  RENDER_REMOTION = 'render_remotion',
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
 * - offer_carousel: personagem apresentador + cards de oferta sincronizados (F2);
 * - offer_piece: peça de ofertas montada pelo cliente no editor + personagem falando
 *   dentro dela (change video-peca-configuravel).
 * A admissão dos formatos novos é por configuração (`MC_FORMATS`, mc-pipeline.config).
 */
export const MC_PROJECT_FORMATS = [
  'scenes',
  'talking_art',
  'offer_carousel',
  'offer_piece',
] as const;
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
/** Canal gravado quando o DTO omite (projetos novos); linhas antigas seguem NULL. */
export const MC_DEFAULT_PROJECT_CHANNEL: McProjectChannel = 'instagram';

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
 * - talk_tile (change video-formatos-personagem, D6/D7): UMA fala = UM clipe,
 *   gerado a partir do tile do kit + TTS da cena → `talk`. Sem keyframe, sem
 *   arte de fundo; a composição (F1/F2) acontece nos steps de projeto.
 */
export const MC_SCENE_TYPES = ['presenter', 'action', 'action_voiceover', 'talk_tile'] as const;
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
  /**
   * Preço anterior ("de"), já formatado como `price`, quando a oferta da arte
   * o traz (ponte arte → projeto, design D9; o F2 o mostra riscado no card).
   * Ausente/null = oferta sem preço anterior.
   */
  originalPrice?: string | null;
  /**
   * Selo curto da oferta ("OFERTA", "-18%", "LEVE 6 PAGUE 5") quando a arte o
   * traz (F2: badge do card). Ausente/null = sem badge. Nunca falado.
   */
  badge?: string | null;
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

/**
 * Janela do personagem na arte que fala (F1, D6): em FRAÇÕES 0..1 do QUADRO DE
 * SAÍDA (não da arte), com o aspecto travado ao do tile do kit. A prévia do
 * frontend usa exatamente este objeto (spec "Prévia da janela").
 */
export interface McCharacterWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Limites do formato F1 (spec video-talking-art "Duração pela fala" / "Fala a partir das ofertas"). */
export const MC_TALKING_ART_MIN_S = 6;
export const MC_TALKING_ART_MAX_S = 25;
export const MC_TALKING_ART_NARRATION_MIN_CHARS = 90;
export const MC_TALKING_ART_NARRATION_MAX_CHARS = 375;
export const MC_TALKING_ART_MAX_CITED_OFFERS = 3;
/** Ofertas da arte que o roteiro F1 congela em `products[]` (o diretor cita ≤ 3 delas). */
export const MC_TALKING_ART_MAX_OFFERS = 12;
/** O diretor divide a narração em até 3 falas (D6) — cada uma vira uma cena `talk_tile`. */
export const MC_TALKING_ART_MAX_SCENES = 3;

// ─────────────── F2 "ofertas em sequência" (change video-formatos-personagem, tarefa 6.6) ───────────────

/** Limites do F2 (spec video-offer-carousel "Ofertas do projeto" / "Uma fala por oferta"). */
export const MC_OFFER_CAROUSEL_MIN_OFFERS = 3;
export const MC_OFFER_CAROUSEL_MAX_OFFERS = 6;
/** Teto da SOMA das falas medidas pelo TTS (s) — acima bloqueia com SPEECH_OVER_LENGTH, sem aceite. */
export const MC_OFFER_CAROUSEL_MAX_SPEECH_S = 30;

/**
 * Presets de layout do F2 (os mesmos da composição `OfferCarousel` do pacote
 * `@chroma/video-templates`): personagem numa faixa lateral (esquerda/direita)
 * ou embaixo; os cards ocupam o resto da área segura.
 */
export const MC_CAROUSEL_LAYOUT_PRESETS = [
  'character_left',
  'character_right',
  'character_bottom',
] as const;
export type McCarouselLayoutPreset = (typeof MC_CAROUSEL_LAYOUT_PRESETS)[number];
export const MC_DEFAULT_CAROUSEL_LAYOUT_PRESET: McCarouselLayoutPreset = 'character_left';

export function isCarouselLayoutPreset(value: unknown): value is McCarouselLayoutPreset {
  return (MC_CAROUSEL_LAYOUT_PRESETS as readonly unknown[]).includes(value);
}

/** Papel de uma fala no roteiro F2: abertura, uma por oferta (na ordem) e fechamento. */
export const MC_CAROUSEL_LINE_KINDS = ['opening', 'offer', 'closing'] as const;
export type McCarouselLineKind = (typeof MC_CAROUSEL_LINE_KINDS)[number];

/**
 * Fala do roteiro F2: ÍNDICE editorial da cena `talk_tile` de mesma identidade
 * (`sceneId`). O texto falado vive em `scenes[].dialogue` (fonte única); aqui
 * ficam só o papel e a oferta vinculada (`offerRef` = id em `offers[]`, igual
 * ao `productRef` da cena; null na abertura e no fechamento).
 */
export interface McCarouselLine {
  sceneId: string;
  kind: McCarouselLineKind;
  offerRef: string | null;
}

export interface McScript {
  /** Versão editorial histórica (incrementa a cada edição), independente do schema. */
  version: number;
  /** 2 = roteiro do pipeline v2. Ausente = legado (nunca inferir de `version`). */
  schemaVersion?: number;
  /**
   * Formato do roteiro (D6): ausente = `scenes` (F3). `talking_art` (F1) e
   * `offer_carousel` (F2) mantêm `schemaVersion = 2` e `scenes[]` de tipo
   * `talk_tile`; os campos abaixo só existem nos formatos novos.
   */
  format?: McProjectFormat;
  /** F1: texto da apresentação em pt-BR (90–375 caracteres); as cenas são a divisão dele por frase. */
  narration?: string;
  /** F1: janela do personagem no quadro de saída (frações 0..1, aspecto do tile). */
  window?: McCharacterWindow;
  /** F1: modo "rosto do logo" — a janela é a caixa do logo na arte (kit `logo_as_is`). */
  logoFace?: boolean;
  /** F1: ofertas citadas na fala (≤ 3 ids de `products[]`). */
  citedOfferIds?: string[];
  /** v2: snapshot congelado dos produtos anunciados (chave estável `id`). */
  products?: McSealProduct[];
  environments?: McScriptEnvironment[];
  scenes: McScriptScene[];
  /** Selo opcional da montagem (plano §5.4); ausente = vídeo sem selo. Legado. */
  seal?: McScriptSeal | null;
  /** Cartela final opcional — ausente quando o usuário não tem estabelecimento. */
  endcard?: McScriptEndcard | null;
  /**
   * Formatos novos (D1): cor (#RRGGBB) da janela/preset onde o tile de fala é
   * composto — o fundo liso do tile é recolorido para ela antes do motor de
   * fala e ela entra no hash do `talk`. Ausente = `tileBackgroundColor` do kit.
   */
  talkBackgroundColor?: string | null;
  /**
   * F2 (tarefa 6.6): ofertas CONGELADAS na ordem do vídeo (3 a 6, cada uma com
   * foto) — nome, preço, preço anterior, unidade, badge, foto e `catalogId`.
   * `products[]` é sempre o ESPELHO desta lista (mesmos ids e ordem) para que
   * validação, cotação e moderação continuem lendo `products`.
   */
  offers?: McSealProduct[];
  /** F2: abertura, uma fala por oferta (na ordem de `offers`) e fechamento — uma cena `talk_tile` cada. */
  lines?: McCarouselLine[];
  /** F2: preset de layout da composição (default `character_left`). */
  layoutPreset?: McCarouselLayoutPreset;
  /** F2: legendas por palavra renderizadas pela composição (o `finalize` não queima de novo). */
  captions?: boolean;
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

/**
 * Trilha por formato quando o pedido não diz nada: o F3 (`scenes`) mantém o
 * contrato v1-B1 (ligada); F1 e F2 nascem SEM trilha (achado 5 da 3.7: a
 * trilha é uma chamada paga ao ElevenLabs Music no `finalize` e precisa ser
 * escolha explícita do usuário — na criação ou na aprovação da produção).
 */
export function defaultMusicEnabled(format: McProjectFormat | null | undefined): boolean {
  return (format ?? 'scenes') === 'scenes' ? MC_DEFAULT_PROJECT_OPTIONS.musicEnabled : false;
}

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
