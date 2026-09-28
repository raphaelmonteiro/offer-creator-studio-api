import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';

export class EanReviewDecisionDto {
  @ApiProperty({ enum: ['match', 'none', 'skip'] })
  @IsIn(['match', 'none', 'skip'])
  decision: 'match' | 'none' | 'skip';

  @ApiProperty({
    required: false,
    type: [String],
    description: 'Imagens escolhidas (decision=match)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsUUID('all', { each: true })
  imageIds?: string[];
}
