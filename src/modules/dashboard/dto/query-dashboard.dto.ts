import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryDashboardDto {
  @ApiProperty({ required: false, default: 5 })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  limit?: number = 5;
}
