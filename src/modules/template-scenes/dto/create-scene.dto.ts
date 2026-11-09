import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { SCENE_LAYOUTS, SceneLayout } from '../domain/scene-faces';
import { SCENE_LIMITS } from '../domain/scene.types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateSceneDto {
  @ApiProperty({ example: 'Páscoa', maxLength: SCENE_LIMITS.nameMaxLength })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SCENE_LIMITS.nameMaxLength)
  name: string;

  @ApiProperty({ example: 'folheto-27x54', description: 'Formato da lista de impressão' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  formatId: string;

  @ApiPropertyOptional({
    enum: SCENE_LAYOUTS,
    default: 'single',
    description:
      '`single` (uma face, como sempre), `front_back` (frente e verso, só nos formatos em retrato) ou `tabloid` (jornal de 4 páginas: Externa e Interna, só no `folheto-54x40`)',
  })
  @IsOptional()
  @IsIn(SCENE_LAYOUTS)
  layout?: SceneLayout;
}
