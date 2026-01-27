import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsOptional, IsUUID } from 'class-validator';

export class MoveImagesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  imageIds: string[];

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'null = mover para raiz',
  })
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}

