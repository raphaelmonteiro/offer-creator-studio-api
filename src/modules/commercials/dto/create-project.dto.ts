import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  MC_ASPECT_RATIOS,
  MC_MAX_SEAL_PRODUCTS,
  MC_PROJECT_CHANNELS,
  MC_PROJECT_FORMATS,
  MC_PROJECT_TIERS,
  MC_SOURCE_ART_KINDS,
  McAspectRatio,
  McProjectChannel,
  McProjectFormat,
  McProjectTier,
  McSourceArtKind,
} from '../domain/mc-types';

/** Caixa do logo na arte (D9b) em frações 0..1 — forma validada aqui; regra de área no service. */
export class LogoBoxDto {
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

/** Origem da arte (D9): documento do Chroma + página + hash do snapshot rasterizado. */
export class SourceArtDto {
  @IsIn(MC_SOURCE_ART_KINDS as readonly string[])
  kind: McSourceArtKind;

  @IsString()
  @Length(1, 64)
  id: string;

  @IsInt()
  @Min(0)
  pageIndex: number;

  @IsString()
  @Length(1, 128)
  snapshotHash: string;
}

/**
 * Produto do catálogo escolhido para o comercial (contrato v1-B1): o FRONT
 * resolve o produto no catálogo e envia `name`+`price` PRONTOS — o backend não
 * consulta a tabela de produtos (mantém o boundary do módulo e garante que o
 * preço anunciado é exatamente o que o usuário viu, plano §5.4).
 */
export class ProjectProductDto {
  @IsString()
  @Length(1, 60)
  name: string;

  /** Preço já formatado para exibição (ex.: "9,99" ou "R$ 9,99"). */
  @IsString()
  @Length(1, 20)
  price: string;

  /** Unidade de venda exibida no selo (kg, un, pct…) — opcional. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 20)
  unit?: string | null;

  /** Foto real do produto (URL em /uploads/*, do catálogo ou da galeria) — referência do keyframe (v2). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/\/uploads\//, { message: 'imageUrl precisa apontar para um arquivo em /uploads/' })
  @MaxLength(500)
  imageUrl?: string | null;
}

export class CreateProjectDto {
  @IsUUID()
  kitId: string;

  @IsString()
  @Length(1, 120)
  title: string;

  /** Briefing livre do usuário — vira input do step 'script' (LLM). */
  @IsString()
  @Length(10, 2000)
  briefing: string;

  /**
   * Default 9:16 (contrato v1-B1) — o front pode omitir. A FORMA aceita os
   * quatro aspectos (4:5 incluído, design D12); o formato `scenes` recusa 4:5
   * como regra de negócio (422 ASPECT_NOT_SUPPORTED_FOR_FORMAT no service).
   */
  @IsOptional()
  @IsIn(MC_ASPECT_RATIOS as readonly string[])
  aspectRatio?: McAspectRatio;

  /** 8–60s: o diretor decide o nº de cenas pela faixa (domain/mc-director). */
  @IsInt()
  @Min(8)
  @Max(60)
  targetDurationS: number;

  /** Produtos que viram SELOS determinísticos na montagem (máx. 6, plano §5.4). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_MAX_SEAL_PRODUCTS)
  @ValidateNested({ each: true })
  @Type(() => ProjectProductDto)
  products?: ProjectProductDto[];

  /** Trilha instrumental na montagem (default: ligada no F3, desligada no F1/F2 — `defaultMusicEnabled`). */
  @IsOptional()
  @IsBoolean()
  musicEnabled?: boolean;

  /** Legendas queimadas a partir dos timestamps do TTS (default true). */
  @IsOptional()
  @IsBoolean()
  captionsEnabled?: boolean;

  /** Faixa desfocada no terço inferior (esconde letreiros inventados pelo gerador). */
  @IsOptional()
  @IsBoolean()
  lowerThirdBlur?: boolean;

  // ── formatos novos (change video-formatos-personagem, D6/D9/D13) ──

  /** `scenes` (default, F3) · `talking_art` (F1) · `offer_carousel` (F2). Admissão por MC_FORMATS no service (422). */
  @IsOptional()
  @IsIn(MC_PROJECT_FORMATS as readonly string[])
  format?: McProjectFormat;

  /** `economico` (default) | `premium` — motor de fala dos formatos novos; rótulo no F3. */
  @IsOptional()
  @IsIn(MC_PROJECT_TIERS as readonly string[])
  tier?: McProjectTier;

  /** `instagram` (default) | `whatsapp` — perfil de encode da entrega. */
  @IsOptional()
  @IsIn(MC_PROJECT_CHANNELS as readonly string[])
  channel?: McProjectChannel;

  /**
   * Arte de fundo (asset `video_art` do usuário, criado por `POST /commercials/art`).
   * OBRIGATÓRIA no formato `talking_art` (forma → 400 aqui; kind/dono → 422 no service).
   */
  @ValidateIf((o: CreateProjectDto) => o.format === 'talking_art' || o.backgroundArtAssetId != null)
  @IsUUID()
  backgroundArtAssetId?: string;

  /** Preset de layout da composição (janela do personagem / cards). */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  layoutPreset?: string;

  /** Caixa do logo na arte, em frações 0..1 (D9b). */
  @IsOptional()
  @ValidateNested()
  @Type(() => LogoBoxDto)
  logoBox?: LogoBoxDto;

  /** Origem da arte que virou projeto (D9). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SourceArtDto)
  sourceArt?: SourceArtDto;
}
