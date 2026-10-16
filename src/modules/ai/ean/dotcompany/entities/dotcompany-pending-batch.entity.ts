import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Último desfecho conhecido da chamada com a chave do lote. */
export type PendingBatchOutcome = 'timeout' | 'network' | 'http_5xx' | 'http_4xx';

/**
 * Lote enviado à DotCompany cujo resultado ficou incerto (timeout, rede, 5xx, 429, 409 em voo).
 * Guarda a `Idempotency-Key` e os GTINs exatos, na ordem enviada, para repetir
 * o MESMO lote com a MESMA chave: se o servidor já completou, volta o replay
 * (`X-Idempotency-Replay: true`) sem novo débito.
 */
@Entity('dotcompany_pending_batches')
export class DotcompanyPendingBatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  idempotencyKey: string;

  // Índice GIN criado só pela migration (`1766500000000`); `synchronize: false` impede o dev de derrubá-lo.
  @Index('IDX_dotcompany_pending_batches_gtins', { synchronize: false })
  @Column({ type: 'jsonb' })
  gtins: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** Chamadas feitas com esta chave (a primeira conta; 409 em voo não conta). */
  @Column({ type: 'int', default: 1 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /** Custo estimado já lançado no consumo por causa da incerteza (ajuste por diferença no fim). */
  @Column({ type: 'int', nullable: true })
  creditsRecorded: number | null;

  /**
   * Último desfecho conhecido com resposta ou erro de transporte (409 em voo não o sobrescreve): decide o
   * que fazer com o custo estimado se a chave virar ORPHANED (5xx/4xx não cobram; timeout/rede é incerto).
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  lastOutcome: PendingBatchOutcome | null;

  /** Depois de 409 `IDEMPOTENCY_IN_FLIGHT`: só reenviar a chave a partir daqui. */
  @Column({ type: 'timestamptz', nullable: true })
  retryNotBefore: Date | null;
}
