import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
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
}
