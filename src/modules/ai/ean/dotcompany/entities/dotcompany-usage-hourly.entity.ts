import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Consumo da DotCompany por hora (início da hora em America/Sao_Paulo). */
@Entity('dotcompany_usage_hourly')
export class DotcompanyUsageHourly {
  @PrimaryColumn({ type: 'timestamptz' })
  hour: Date;

  @Column({ type: 'int', default: 0 })
  requests: number;

  @Column({ type: 'int', default: 0 })
  credits: number;

  @Column({ type: 'int', default: 0 })
  found: number;

  @Column({ type: 'int', default: 0 })
  notFound: number;

  @Column({ type: 'int', default: 0 })
  errors: number;

  @Column({ type: 'int', default: 0 })
  interactiveRequests: number;

  @Column({ type: 'int', default: 0 })
  batchRequests: number;
}
