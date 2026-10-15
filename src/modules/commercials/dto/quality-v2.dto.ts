import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
  Matches,
  MaxLength,
} from 'class-validator';
import { MC_MAX_SCENES, MC_SCENE_MAX_S, MC_SCENE_MIN_S } from '../domain/mc-director';
import {
  MC_CAROUSEL_LAYOUT_PRESETS,
  MC_MAX_SEAL_PRODUCTS,
  MC_OFFER_CAROUSEL_MAX_OFFERS,
  MC_SAFE_AREAS,
  MC_SCENE_TYPES,
  MC_TALKING_ART_MAX_CITED_OFFERS,
  MC_TALKING_ART_MAX_OFFERS,
  McCarouselLayoutPreset,
} from '../domain/mc-types';

/**
 * DTOs do pipeline v2 (ADR-001 §4 / plano §4 "contrato de API sugerido").
 * Toda escrita carrega `expectedRevision`: escrita concorrente antiga recebe
 * 409 REVISION_CONFLICT em vez de sobrescrever silenciosamente.
 */

export class SealCueDto {
  @IsNumber()
  @Min(0)
  startS: number;

  @IsNumber()
  @Min(0)
  endS: number;
}

export class ScriptProductV2Dto {
  /** Chave estável do snapshot; omitida em produto novo (o servidor gera). */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  id?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 64)
  catalogId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 20)
  unit?: string | null;

  @IsString()
  @Length(1, 60)
  name: string;

  @IsString()
  @Length(1, 20)
  price: string;

  /** Foto real do produto (URL em /uploads/*, do catálogo ou da galeria) — referência do keyframe (v2). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/\/uploads\//, { message: 'imageUrl precisa apontar para um arquivo em /uploads/' })
  @MaxLength(500)
  imageUrl?: string | null;

  /**
   * Preço anterior ("de", formatado como `price`). Omitido = PRESERVA o
   * congelado da mesma oferta (`id`); `null` remove.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 20)
  originalPrice?: string | null;

  /** Selo do card do F2 ("OFERTA", "-18%"). Omitido = preserva; `null` remove. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 24)
  badge?: string | null;
}

export class ScriptEnvironmentDto {
  @IsString()
  @Length(1, 64)
  id: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  assetId?: string | null;

  @IsString()
  @Length(1, 600)
  description: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class ScriptSceneV2Dto {
  /** Omitido em cena nova; o servidor gera. Cenas existentes DEVEM enviar o seu. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  sceneId?: string;

  @IsIn(MC_SCENE_TYPES as readonly string[])
  sceneType: (typeof MC_SCENE_TYPES)[number];

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  initialFrame?: string;

  /**
   * Ação/movimento da cena. Em `talk_tile` (change video-formatos-personagem,
   * D6) é só o GESTO opcional enviado ao motor de fala: pode vir vazio ou
   * omitido; nos demais tipos continua obrigatório (3 a 2000 caracteres).
   */
  @ValidateIf(
    (o: ScriptSceneV2Dto) =>
      o.sceneType !== 'talk_tile' ||
      (typeof o.actionPrompt === 'string' && o.actionPrompt.trim() !== ''),
  )
  @IsString()
  @Length(3, 2000)
  actionPrompt?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 1000)
  dialogue?: string | null;

  @IsInt()
  @Min(MC_SCENE_MIN_S - 1)
  @Max(MC_SCENE_MAX_S + 18)
  durationS: number;

  /** Produto do snapshot ou null = "sem oferta". Obrigatório quando há produtos. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 64)
  productRef?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => SealCueDto)
  sealCue?: SealCueDto | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(MC_SAFE_AREAS as readonly string[])
  safeArea?: (typeof MC_SAFE_AREAS)[number] | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 200)
  camera?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 64)
  environmentId?: string | null;
}

export class ScriptEndcardV2Dto {
  @IsString()
  @Length(1, 60)
  storeName: string;
}

/**
 * Janela do personagem (F1, change video-formatos-personagem D6): frações 0..1
 * do quadro de saída. A FORMA (números no intervalo) é validada aqui; a regra
 * "inteira no quadro / área segura / aspecto do tile" é do service (422).
 */
export class CharacterWindowDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  x: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  y: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  w: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  h: number;
}

/** PATCH /commercials/projects/:id/script (pipeline v2). */
export class UpdateScriptV2Dto {
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MC_MAX_SCENES)
  @ValidateNested({ each: true })
  @Type(() => ScriptSceneV2Dto)
  scenes: ScriptSceneV2Dto[];

  /**
   * Snapshot de produtos. Omitido PRESERVA o atual; cada produto omitindo um
   * campo opcional (catálogo, unidade, foto, preço anterior, badge) preserva o
   * valor congelado do mesmo `id`. Teto da FORMA = 12 (ofertas da arte do F1);
   * o teto por formato (F3 6, F2 6) é regra do service (422).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_TALKING_ART_MAX_OFFERS)
  @ValidateNested({ each: true })
  @Type(() => ScriptProductV2Dto)
  products?: ScriptProductV2Dto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ScriptEnvironmentDto)
  environments?: ScriptEnvironmentDto[];

  // ── formato F2 "ofertas em sequência" (tarefa 6.6): omitidos preservam o atual ──

  /**
   * F2: ofertas congeladas NA ORDEM do vídeo (prevalece sobre `products`, que
   * vira o espelho). As falas (`lines`) são derivadas das cenas — abertura,
   * uma por oferta (`productRef`), fechamento.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_OFFER_CAROUSEL_MAX_OFFERS)
  @ValidateNested({ each: true })
  @Type(() => ScriptProductV2Dto)
  offers?: ScriptProductV2Dto[];

  /** F2: preset de layout (`character_left` | `character_right` | `character_bottom`). */
  @IsOptional()
  @IsIn(MC_CAROUSEL_LAYOUT_PRESETS as readonly string[])
  layoutPreset?: McCarouselLayoutPreset;

  /** F2: legendas por palavra desenhadas pela composição. */
  @IsOptional()
  @IsBoolean()
  captions?: boolean;

  /** Omitir PRESERVA a cartela atual; `null` remove. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => ScriptEndcardV2Dto)
  endcard?: ScriptEndcardV2Dto | null;

  // ── formato F1 "arte que fala" (D6): omitidos preservam o valor atual do roteiro ──

  /** Texto da apresentação (pt-BR). As cenas enviadas são a divisão dele em falas. */
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  narration?: string;

  /** Janela do personagem em frações 0..1 do quadro de saída. */
  @IsOptional()
  @ValidateNested()
  @Type(() => CharacterWindowDto)
  window?: CharacterWindowDto;

  /** Modo "rosto do logo" (kit `logo_as_is`). */
  @IsOptional()
  @IsBoolean()
  logoFace?: boolean;

  /** Ofertas citadas na fala (ids de `products[]`, no máximo 3). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_TALKING_ART_MAX_CITED_OFFERS)
  @IsString({ each: true })
  citedOfferIds?: string[];

  /** Cor da janela (#RRGGBB) para a qual o fundo do tile é recolorido; `null` volta à cor do kit. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'talkBackgroundColor precisa ser #RRGGBB' })
  talkBackgroundColor?: string | null;
}

export class RevisionDto {
  @IsInt()
  @Min(0)
  expectedRevision: number;
}

/** POST /projects/:id/scenes/:sceneId/previews */
export class RegeneratePreviewDto extends RevisionDto {
  @IsIn(['image', 'voice'])
  kind: 'image' | 'voice';
}

/** PATCH /projects/:id/scenes/:sceneId/preview-selection */
export class SelectPreviewDto extends RevisionDto {
  @IsString()
  @Length(1, 64)
  stepId: string;
}

/** PATCH /projects/:id/scenes/:sceneId/dialogue (v2) */
export class UpdateDialogueV2Dto extends RevisionDto {
  @IsString()
  @Length(1, 1000)
  dialogue: string;
}

/** POST /projects/:id/approve-production */
export class ApproveProductionDto extends RevisionDto {
  @IsString()
  @Length(16, 128)
  manifestHash: string;

  /** Orçamento aceito (limite da fase). Se omitido, o servidor usa a cotação corrente. */
  @IsOptional()
  @IsInt()
  @Min(0)
  budgetCredits?: number;

  /** Aceite explícito de entregar sem legenda nas cenas sem alinhamento (nunca silencioso). */
  @IsOptional()
  @IsBoolean()
  acceptMissingCaptions?: boolean;

  /**
   * F1 (spec "Duração pela fala"): aceite explícito da soma das falas fora de
   * 6–25 s — persistido em `quality.speechDurationAccepted`.
   */
  @IsOptional()
  @IsBoolean()
  acceptSpeechDuration?: boolean;

  /**
   * Trilha instrumental escolhida na revisão (F1/F2): gravada em
   * `options.musicEnabled` junto da aprovação, antes de materializar (entra no
   * hash do `finalize` e na cotação). Omitido = mantém a opção do projeto.
   */
  @IsOptional()
  @IsBoolean()
  musicEnabled?: boolean;
}

export class CompositionSceneDto {
  @IsString()
  @Length(1, 64)
  sceneId: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 64)
  productRef?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => SealCueDto)
  sealCue?: SealCueDto | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(MC_SAFE_AREAS as readonly string[])
  safeArea?: (typeof MC_SAFE_AREAS)[number] | null;
}

/**
 * Oferta do F2 na correção de COMPOSIÇÃO: só foto, badge, unidade e preço
 * anterior mudam aqui (render + finalize). `name`/`price` são aceitos na forma
 * mas, se diferentes do congelado, o service recusa com 422
 * OFFER_SPOKEN_FIELDS_CHANGED (são falados: use PATCH /offers/:offerId).
 */
export class CompositionOfferDto {
  @IsString()
  @Length(1, 64)
  id: string;

  @IsOptional()
  @IsString()
  @Matches(/\/uploads\//, { message: 'imageUrl precisa apontar para um arquivo em /uploads/' })
  @MaxLength(500)
  imageUrl?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 24)
  badge?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 20)
  unit?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 20)
  originalPrice?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20)
  price?: string;
}

/**
 * PATCH /projects/:id/composition — correção só de composição após a entrega
 * (assembly_only: sem TTS nem clipe novos). FORMAT-AWARE (BUG A):
 * - `scenes` (F3): selos/produtos/ordem/cartela/trilha/legendas/faixa;
 * - `talking_art` (F1): `window`, `talkBackgroundColor`, `endcard`,
 *   `captionsEnabled`, `musicEnabled` → compose_ffmpeg + finalize;
 * - `offer_carousel` (F2): `layoutPreset`, `captionsEnabled`, `offers` (foto,
 *   badge, unidade, preço anterior), `offerOrder` (ou `order` das cenas),
 *   `endcard`, `musicEnabled` → render_remotion + finalize.
 * Campo de outro formato → 422 COMPOSITION_FIELD_NOT_SUPPORTED.
 */
export class UpdateCompositionDto extends RevisionDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_MAX_SCENES)
  @ValidateNested({ each: true })
  @Type(() => CompositionSceneDto)
  scenes?: CompositionSceneDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_MAX_SEAL_PRODUCTS)
  @ValidateNested({ each: true })
  @Type(() => ScriptProductV2Dto)
  products?: ScriptProductV2Dto[];

  /** Ordem das cenas por sceneId (reordenar preserva a associação). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_MAX_SCENES)
  @IsString({ each: true })
  order?: string[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => ScriptEndcardV2Dto)
  endcard?: ScriptEndcardV2Dto | null;

  @IsOptional()
  @IsBoolean()
  musicEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  captionsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  lowerThirdBlur?: boolean;

  // ── F1 (talking_art) ──

  /** F1: janela do personagem (frações do quadro); área segura/aspecto do tile no service (422). */
  @IsOptional()
  @ValidateNested()
  @Type(() => CharacterWindowDto)
  window?: CharacterWindowDto;

  /** F1: cor da janela (#RRGGBB); `null` volta à cor do kit. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'talkBackgroundColor precisa ser #RRGGBB' })
  talkBackgroundColor?: string | null;

  // ── F2 (offer_carousel) ──

  /** F2: preset de layout da composição. */
  @IsOptional()
  @IsIn(MC_CAROUSEL_LAYOUT_PRESETS as readonly string[])
  layoutPreset?: McCarouselLayoutPreset;

  /** F2: correção visual por oferta (foto, badge, unidade, preço anterior). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_OFFER_CAROUSEL_MAX_OFFERS)
  @ValidateNested({ each: true })
  @Type(() => CompositionOfferDto)
  offers?: CompositionOfferDto[];

  /** F2: nova ordem das ofertas (ids) — as falas acompanham; nenhum áudio/clipe é regerado. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_OFFER_CAROUSEL_MAX_OFFERS)
  @IsString({ each: true })
  offerOrder?: string[];
}

/**
 * PATCH /projects/:id/offers/:offerId (F2, tarefa 6.8) — correção de UMA
 * oferta pelo tipo de mudança: foto/badge/unidade/preço anterior → só
 * composição (render + finalize); nome ou preço atual → a fala da oferta é
 * reescrita (proposta do diretor, ou `dialogue` confirmado) e só o TTS/clipe
 * dela são refeitos na próxima preparação. `dryRun` devolve a proposta sem gravar.
 */
export class UpdateOfferDto extends RevisionDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20)
  price?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 20)
  originalPrice?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 20)
  unit?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 24)
  badge?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/\/uploads\//, { message: 'imageUrl precisa apontar para um arquivo em /uploads/' })
  @MaxLength(500)
  imageUrl?: string;

  /** Fala confirmada/editada pelo usuário para a oferta (ausente = a proposta do diretor). */
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  dialogue?: string;

  /** true = só devolve a proposta de fala, sem gravar nada. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
