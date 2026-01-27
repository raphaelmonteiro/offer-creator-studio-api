import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject, IsUUID, IsIn } from 'class-validator';

export class CreateFlyerDto {
  @ApiProperty({ example: 'Ofertas de Janeiro' })
  @IsString()
  name: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUUID()
  clientId?: string | null;

  @ApiProperty({ type: 'object' })
  @IsObject()
  configuration: any;

  @ApiProperty({
    required: false,
    enum: ['auto', 'custom'],
    default: 'auto',
  })
  @IsOptional()
  @IsString()
  @IsIn(['auto', 'custom'])
  layout?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Configuração do grid quando layout = "custom"',
    type: 'object',
  })
  @IsOptional()
  @IsObject()
  customGridConfig?: any | null;
}
