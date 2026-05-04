import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateFlyerBuilderV2DocumentDto {
  @ApiProperty({ example: 'Encarte V2 de Janeiro' })
  @IsString()
  name: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  clientId?: string | null;

  @ApiProperty({ required: false, enum: ['draft', 'published'], default: 'draft' })
  @IsOptional()
  @IsString()
  @IsIn(['draft', 'published'])
  status?: string;

  @ApiProperty({ type: 'object' })
  @IsObject()
  document: any;
}

