import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  MC_CAROUSEL_OFFERS_MAX,
  MC_CAROUSEL_OFFERS_MIN,
  MC_TALKING_ART_OFFERS_MAX,
} from '../domain/mc-art-offers';
import {
  MC_PROJECT_CHANNELS,
  MC_PROJECT_TIERS,
  MC_SOURCE_ART_KINDS,
  McProjectChannel,
  McProjectTier,
  McSourceArtKind,
} from '../domain/mc-types';

/** Formatos que nascem da ponte arte → projeto (D9): o F3 (`scenes`) não tem arte de fundo. */
export const MC_FROM_ART_FORMATS = ['talking_art', 'offer_carousel'] as const;
export type McFromArtFormat = (typeof MC_FROM_ART_FORMATS)[number];

/**
 * Limites de seleção por formato como FORMA do DTO (400 pelo pipe, convenção
 * D13): `offer_carousel` exige 3 a 6 ofertas; `talking_art` aceita até 3,
 * opcionais. Um só constraint porque `@ValidateIf` vale para todos os
 * decorators da propriedade e os dois formatos têm limites diferentes.
 */
@ValidatorConstraint({ name: 'offersBoundsForFormat', async: false })
export class OffersBoundsForFormat implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const format = (args.object as { format?: string }).format;
    const count = Array.isArray(value) ? value.length : value === undefined ? 0 : -1;
    if (count < 0) return false;
    if (format === 'offer_carousel') {
      return count >= MC_CAROUSEL_OFFERS_MIN && count <= MC_CAROUSEL_OFFERS_MAX;
    }
    return count <= MC_TALKING_ART_OFFERS_MAX;
  }

  defaultMessage(args: ValidationArguments): string {
    const format = (args.object as { format?: string }).format;
    if (format === 'offer_carousel') {
      return `offers precisa ter de ${MC_CAROUSEL_OFFERS_MIN} a ${MC_CAROUSEL_OFFERS_MAX} ofertas para "ofertas em sequência"`;
    }
    return `offers aceita no máximo ${MC_TALKING_ART_OFFERS_MAX} ofertas citadas para "arte que fala"`;
  }
}

/** Oferta escolhida: `id` da oferta na página (como devolvido por GET .../offers) + imagem opcional. */
export class FromArtOfferDto {
  @IsString()
  @Length(1, 120)
  id: string;

  /** Foto do catálogo/galeria para uma oferta sem imagem na arte — só /uploads/* (anti-SSRF). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/\/uploads\//, { message: 'imageUrl precisa apontar para um arquivo em /uploads/' })
  @MaxLength(500)
  imageUrl?: string | null;
}

/** Caixa do logo em frações 0..1 da arte (D9b). */
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

export class CreateProjectFromArtDto {
  /** Asset `video_art` devolvido por POST /commercials/art. */
  @IsUUID()
  artAssetId: string;

  @IsIn(MC_SOURCE_ART_KINDS as readonly string[])
  sourceKind: McSourceArtKind;

  /** Id do `flyers` (flyer) ou do documento V2 (v2_document / social). */
  @IsUUID()
  sourceId: string;

  /** Página da arte (0-based); default 0. */
  @IsOptional()
  @IsInt()
  @Min(0)
  pageIndex?: number;

  @IsIn(MC_FROM_ART_FORMATS as readonly string[])
  format: McFromArtFormat;

  @IsOptional()
  @IsIn(MC_PROJECT_TIERS as readonly string[])
  tier?: McProjectTier;

  @IsOptional()
  @IsIn(MC_PROJECT_CHANNELS as readonly string[])
  channel?: McProjectChannel;

  /** Kit aprovado; ausente = kit sugerido pelo cliente da arte (422 KIT_REQUIRED se não houver). */
  @IsOptional()
  @IsUUID()
  kitId?: string;

  /**
   * Preset de layout da composição. F2: `character_left` (default) |
   * `character_right` | `character_bottom` (o roteiro F2 o congela).
   */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  layoutPreset?: string;

  /** Caixa do logo derivada do layout pela ponte (D9b camada a) — usada como está, sem detecção. */
  @IsOptional()
  @ValidateNested()
  @Type(() => LogoBoxDto)
  logoBox?: LogoBoxDto;

  /**
   * Pede o modo "rosto do logo" (F1, kit `logo_as_is`): sem `logoBox`, a
   * criação roda a detecção UMA vez (camada b) e grava a proposta (confiança
   * ≥ 0,7) para o usuário confirmar; abaixo disso o projeto nasce sem caixa.
   */
  @IsOptional()
  @IsBoolean()
  logoFace?: boolean;

  /**
   * Seleção de ofertas, NA ORDEM: 3 a 6 para `offer_carousel` (obrigatória —
   * por isso `@ValidateIf` em vez de `@IsOptional`, que pularia a checagem
   * com o campo ausente); até 3 citadas para `talking_art` (opcional — sem
   * ela, as ofertas da página).
   */
  @ValidateIf(
    (o: CreateProjectFromArtDto) => o.format === 'offer_carousel' || o.offers !== undefined,
  )
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FromArtOfferDto)
  @Validate(OffersBoundsForFormat)
  offers?: FromArtOfferDto[];

  @IsOptional()
  @IsString()
  @Length(1, 120)
  title?: string;

  /** Briefing livre; ausente = gerado a partir das ofertas da arte. */
  @IsOptional()
  @IsString()
  @Length(10, 2000)
  briefing?: string;

  /** Duração alvo; ausente = default do formato (F1 15 s, F2 25 s). */
  @IsOptional()
  @IsInt()
  @Min(6)
  @Max(60)
  targetDurationS?: number;
}

/**
 * PUT /commercials/projects/:id/logo-box — caixa marcada/confirmada pelo
 * usuário, em frações 0..1 da arte (forma → 400 pelo pipe; caixa fora da
 * arte ou pequena demais → 422 no service).
 */
export class SetLogoBoxDto extends LogoBoxDto {}

/** GET /commercials/projects?sourceKind=&sourceId= — vídeos de uma arte. */
export class ListProjectsQueryDto {
  @IsOptional()
  @IsIn(MC_SOURCE_ART_KINDS as readonly string[])
  sourceKind?: McSourceArtKind;

  @IsOptional()
  @IsUUID()
  sourceId?: string;
}

/** GET /commercials/kits/suggest?clientId= */
export class KitSuggestQueryDto {
  @IsUUID()
  clientId: string;
}

/** GET /commercials/art-sources/:kind/:id/offers?pageIndex= */
export class ArtOffersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pageIndex?: number;
}
