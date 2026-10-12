import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Candidato de mascotização do logo (design D4): uma imagem derivada do logo
 * no estilo do kit, gerada em rodadas de 4 a 6. As rodadas anteriores são
 * preservadas para comparação; o escolhido vira `identityAssetId` do kit.
 *
 * `kitId`/`assetId` são referências LÓGICAS (sem FK física), como as demais
 * ligações do módulo — o ciclo de vida é do kit, resolvido no service.
 */
@Entity('mc_kit_candidates')
@Index('IDX_mc_kit_candidates_kit_round', ['kitId', 'roundId'])
export class McKitCandidate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  kitId: string;

  /** Rodada de geração (uuid gerado pelo service); o kit guarda a corrente em `candidateRoundId`. */
  @Column({ type: 'uuid' })
  roundId: string;

  /** Posição do candidato dentro da rodada (0..5). */
  @Column({ type: 'int' })
  idx: number;

  /** Asset da imagem gerada (animation_assets); nulo enquanto a geração não concluiu. */
  @Column({ type: 'uuid', nullable: true })
  assetId: string | null;

  /** Prompt efetivamente enviado ao gerador (auditoria/reprodutibilidade). */
  @Column({ type: 'text' })
  prompt: string;

  /** Ajustes em texto livre do usuário que motivaram esta rodada. */
  @Column({ type: 'text', nullable: true })
  adjustments: string | null;

  @Column({ type: 'boolean', default: false })
  chosen: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
