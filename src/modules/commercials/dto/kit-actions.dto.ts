import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Aprovação do kit (review → approved, plano §4). `voiceId` opcional aqui
 * resolve o fluxo em que o kit foi criado sem voz: o usuário escolhe a voz na
 * tela de review (com preview) e aprova num passo só — sem uma rota PATCH
 * dedicada. A aprovação continua EXIGINDO voz definida (aqui ou na criação).
 */
export class ApproveKitDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  voiceId?: string;
}

/** Regeneração de UMA referência do grid (plano §4: "regeneração por célula"). */
export class RegenerateReferenceDto {
  @IsInt()
  @Min(0)
  @Max(3)
  slot: number;
}

/**
 * Item da ficha nas duas línguas. O front devolve os pares que leu do GET
 * (sem os que o usuário removeu) — pareamento explícito em vez de índice,
 * que quebraria se a ficha mudasse entre a leitura e o salvamento.
 */
export class KitSheetItemDto {
  @IsString()
  @MaxLength(240)
  en: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  pt?: string;
}

/**
 * Edição da ficha do personagem durante a revisão do kit (v1.15).
 * Campo omitido = mantém o que já está gravado; array vazio = zera aquela
 * seção. Depois de salvar, o usuário refaz as imagens que quiser — a ficha
 * nova entra nos prompts das referências e das cenas.
 */
export class UpdateKitSheetDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => KitSheetItemDto)
  traits?: KitSheetItemDto[];

  /** Props removíveis (cesta, caixa, celular): saem das referências. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => KitSheetItemDto)
  accessories?: KitSheetItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => KitSheetItemDto)
  doNots?: KitSheetItemDto[];

  /** Instruções livres em pt-BR ("tire a cesta da mão dele"). */
  @IsOptional()
  @IsString()
  @MaxLength(600)
  adjustments?: string;
}
