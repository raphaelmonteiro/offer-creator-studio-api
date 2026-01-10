import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional } from 'class-validator';

export enum UploadFolder {
  PRODUCTS = 'products',
  LOGOS = 'logos',
  TEMPLATES = 'templates',
  GENERAL = 'general',
  FONTS = 'fonts',
  AVATARS = 'avatars',
  THUMBNAILS = 'thumbnails',
}

export class UploadDto {
  @ApiProperty({ enum: UploadFolder, default: UploadFolder.GENERAL })
  @IsOptional()
  @IsEnum(UploadFolder)
  folder?: UploadFolder = UploadFolder.GENERAL;
}
