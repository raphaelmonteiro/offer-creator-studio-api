import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
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
import { MC_ASPECT_RATIOS, McAspectRatio, MC_MAX_SEAL_PRODUCTS } from '../domain/mc-types';

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

  /** Default 9:16 (contrato v1-B1) — o front pode omitir. */
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

  /** Trilha instrumental na montagem (default true). */
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
}
