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
  MC_MAX_SEAL_PRODUCTS,
  MC_SAFE_AREAS,
  MC_SCENE_TYPES,
  MC_TALKING_ART_MAX_CITED_OFFERS,
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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_MAX_SEAL_PRODUCTS)
  @ValidateNested({ each: true })
  @Type(() => ScriptProductV2Dto)
  products?: ScriptProductV2Dto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ScriptEnvironmentDto)
  environments?: ScriptEnvironmentDto[];

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

/** PATCH /projects/:id/composition — correção só de composição após a entrega (assembly_only). */
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
}
