import { ApiProperty } from '@nestjs/swagger';

export class CorrectionDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  productId: string;

  @ApiProperty({ enum: ['name', 'observation', 'badgeText'] })
  field: 'name' | 'observation' | 'badgeText';

  @ApiProperty({ example: 'Arroz Tipo 1 Camil 5kg' })
  original: string;

  @ApiProperty({ example: 'Arroz Tipo 1 Camil 5 kg' })
  suggestion: string;
}

export class SpellCheckResponseDto {
  @ApiProperty({ type: [CorrectionDto] })
  corrections: CorrectionDto[];
}
