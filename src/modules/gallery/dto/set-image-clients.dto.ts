import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';

export class SetImageClientsDto {
  @ApiProperty({
    type: [String],
    description:
      'Lista completa de clientes desta imagem. Substitui a marcação atual — enviar [] desvincula de todos.',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  clientIds: string[];
}
