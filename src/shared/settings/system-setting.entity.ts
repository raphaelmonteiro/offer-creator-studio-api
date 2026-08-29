import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Configuração operacional key/value em banco (plano-comerciais §6.7):
 * heartbeat do worker, kill-switch 'mc_paused' etc. Schema espelhado na
 * migration 1765400000000-CreateSystemSettings (prod roda migration;
 * dev usa synchronize).
 */
@Entity('system_settings')
export class SystemSetting {
  @PrimaryColumn({ type: 'text' })
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
