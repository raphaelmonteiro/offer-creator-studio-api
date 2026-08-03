import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';

export type BulkImageClientsMode = 'add' | 'remove' | 'replace';

export class BulkImageClientsDto {
  @ApiProperty({ type: [String], description: 'Imagens que receberão a marcação.' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  imageIds: string[];

  @ApiProperty({ type: [String], description: 'Clientes a vincular/desvincular.' })
  @IsArray()
  @IsUUID('4', { each: true })
  clientIds: string[];

  @ApiPropertyOptional({
    enum: ['add', 'remove', 'replace'],
    default: 'add',
    description:
      '`add` vincula sem remover nada (default, idempotente); `remove` desvincula os pares enviados; `replace` faz as imagens terem exatamente esses clientes.',
  })
  @IsOptional()
  @IsIn(['add', 'remove', 'replace'])
  mode?: BulkImageClientsMode = 'add';
}
