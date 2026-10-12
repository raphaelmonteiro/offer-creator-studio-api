import { IsOptional, Matches } from 'class-validator';

/** Mês do relatório de custos (`YYYY-MM`, UTC); ausente = mês corrente. */
export const MC_COST_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `GET /commercials/admin/costs?month=YYYY-MM` (tarefa 8.3). */
export class AdminCostsQueryDto {
  @IsOptional()
  @Matches(MC_COST_MONTH_PATTERN, { message: 'month deve estar no formato YYYY-MM' })
  month?: string;
}
