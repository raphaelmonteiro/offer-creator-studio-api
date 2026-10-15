import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Lote enviado à DotCompany cujo resultado ficou incerto (timeout, rede, 5xx).
 * Guarda a `Idempotency-Key` e os GTINs exatos, na ordem enviada, para repetir
 * o MESMO lote com a MESMA chave: se o servidor já completou, volta o replay
 * (`X-Idempotency-Replay: true`) sem novo débito.
 */
@Entity('dotcompany_pending_batches')
// O índice GIN em `gtins` vem só da migration (o TypeORM não declara GIN; em dev o synchronize o ignora/derruba, sem efeito no resultado).
export class DotcompanyPendingBatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 64 })
  idempotencyKey: string;

  @Column({ type: 'jsonb' })
  gtins: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Chamadas feitas com esta chave (a primeira conta). */
  @Column({ type: 'int', default: 1 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  /** Custo estimado já lançado no consumo por causa da incerteza (ajuste por diferença no fim). */
  @Column({ name: 'credits_recorded', type: 'int', nullable: true })
  creditsRecorded: number | null;
}
