import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { maskShapeProblem } from '../domain/scene-mask-shape';
import { MaskShape, SCENE_LIMITS, SceneZoneName } from '../domain/scene.types';

const ZONES: SceneZoneName[] = ['header', 'body', 'footer'];

/** Forma do pincel ou do laço (D-10): até 2000 pontos, coordenadas entre 0 e 1. */
const IsMaskShape = () =>
  ValidateBy({
    name: 'isMaskShape',
    validator: {
      validate: (value: unknown) => maskShapeProblem(value) === null,
      defaultMessage: ({ value }) => `mask inválida: ${maskShapeProblem(value)}`,
    },
  });

export class RegionDto {
  @ApiProperty({ minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  x: number;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  y: number;

  @ApiProperty({ minimum: 0, maximum: 1, description: 'Largura, fração da cena' })
  @IsNumber()
  @Min(0.0001)
  @Max(1)
  w: number;

  @ApiProperty({ minimum: 0, maximum: 1, description: 'Altura, fração da cena' })
  @IsNumber()
  @Min(0.0001)
  @Max(1)
  h: number;
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class MessageAttachmentDto {
  @ApiProperty({ description: 'Asset da própria cena (logo enviado por upload)' })
  @IsUUID()
  assetId: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

/**
 * Mensagem do chat. O alvo da edição é um só: `region`, `mask`, `zone` e `targetElementId` são
 * mutuamente exclusivos (400, conferido no service). `targetElementId` é só uma dica de camada ao Diretor, não é
 * marcação. Campo fora desta lista (`confirmGlobal`, `replyToMessageId`) é 400 pelo `forbidNonWhitelisted`.
 */
export class SendMessageDto {
  @ApiProperty({
    example: 'campo verde com sol à direita',
    maxLength: SCENE_LIMITS.messageMaxLength,
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SCENE_LIMITS.messageMaxLength)
  content: string;

  @ApiProperty({ description: '`revision` da cena que o cliente viu por último', minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiPropertyOptional({ type: [MessageAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => MessageAttachmentDto)
  attachments?: MessageAttachmentDto[];

  @ApiPropertyOptional({ type: RegionDto, description: 'Retângulo marcado (0..1)' })
  @IsOptional()
  @ValidateNested()
  @Type(() => RegionDto)
  region?: RegionDto;

  @ApiPropertyOptional({
    description:
      '`{kind:"brush",strokes,radius}` ou `{kind:"lasso",points}`; até 2000 pontos, coordenadas 0..1',
  })
  @IsOptional()
  @IsMaskShape()
  mask?: MaskShape;

  @ApiPropertyOptional({ enum: ZONES })
  @IsOptional()
  @IsIn(ZONES)
  zone?: SceneZoneName;

  @ApiPropertyOptional({ maxLength: 64, description: 'Elemento selecionado na prévia' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetElementId?: string;
}
