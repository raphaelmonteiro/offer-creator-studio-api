import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject, IsUUID } from 'class-validator';

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
}
