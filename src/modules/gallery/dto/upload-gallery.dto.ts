import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class UploadGalleryDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}

