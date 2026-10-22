import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { MC_PIECE_ASPECT_RATIOS, McPieceAspectRatio, McPieceDocument } from '../domain/mc-piece';
import { MC_PIECE_KINDS, McPieceKind } from '../entities/mc-piece.entity';

/**
 * DTOs da peça de ofertas configurável (change video-peca-configuravel,
 * grupo 4). Convenção D13: FORMA → 400 pelo pipe global; o DESCRITOR (um
 * documento aninhado de blocos de tipos diferentes) é validado pelo domínio
 * (`validatePieceDocument`), que aponta o bloco e o item: forma estrutural
 * inválida → 422 PIECE_INVALID; regras de negócio ainda abertas (sem
 * personagem, poucos produtos) ficam em `issues[]` da resposta para o editor
 * mostrar, sem bloquear o autosave.
 */
export class CreatePieceDto {
  @IsUUID()
  clientId: string;

  @IsIn(MC_PIECE_ASPECT_RATIOS as readonly string[])
  aspectRatio: McPieceAspectRatio;

  /** Modelo salvo (`kind = 'template'`) de onde a peça nasce; ausente = peça em branco. */
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;
}

export class UpdatePieceDto {
  /** Descritor inteiro (autosave manda o documento completo, nunca um patch). */
  @IsObject()
  document: McPieceDocument;

  /** Revisão que o editor tem; diferente da gravada → 409 REVISION_CONFLICT. */
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;
}

export class SaveAsTemplateDto {
  @IsString()
  @Length(1, 120)
  name: string;
}

export class ListPiecesQueryDto {
  @IsOptional()
  @IsIn(MC_PIECE_KINDS as readonly string[])
  kind?: McPieceKind;

  @IsOptional()
  @IsUUID()
  clientId?: string;
}
