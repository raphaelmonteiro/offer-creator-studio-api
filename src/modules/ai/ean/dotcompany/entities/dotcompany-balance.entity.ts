import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

/** Saldo conhecido da conta DotCompany (linha única, id = 1) e controle dos alertas. */
@Entity('dotcompany_balance')
@Check('CHK_dotcompany_balance_single_row', '"id" = 1')
export class DotcompanyBalance {
  @PrimaryColumn({ type: 'smallint', default: 1 })
  id: number;

  /** Créditos disponíveis (1 crédito = R$ 0,01); null = nunca conferido. */
  @Column({ type: 'int', nullable: true })
  available: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  checkedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lowAlertSentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  emptyAlertSentAt: Date | null;

  /** Dia (America/Sao_Paulo) em que o alerta de limite diário já saiu. */
  @Column({ type: 'date', nullable: true })
  dayLimitAlertDay: string | null;
}
