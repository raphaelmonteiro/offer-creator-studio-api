import { McVoiceDeliveryOverride } from '../domain/mc-voice-delivery';
import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { McKitIdentityMode, McKitSource, McKitStyle } from '../domain/mc-kit-identity';
import { McKitMouthGate } from '../domain/mc-mouth-gate';
import { McKitStatus } from '../domain/mc-state-machines';

/**
 * O enum mudou-se para domain/mc-state-machines (casa das máquinas formais,
 * junto com MC_KIT_TRANSITIONS); o reexport preserva os imports existentes.
 */
export { McKitStatus };

/** numeric do pg chega como texto: a coluna de custo do kit sai como número (US$) na entidade e na API. */
const usdColumn = {
  to: (value: number | null | undefined) => value,
  from: (value: string | number | null) => (value == null ? 0 : Number(value)),
};

/**
 * Kit do mascote — Ativo de Personagem, 1× por mascote (plano-comerciais §4):
 * descrição canônica + voz + assets de referência. IMUTÁVEL após approved
 * (mudança de identidade = nova versão), para que projetos antigos continuem
 * reproduzíveis.
 *
 * `mascotId` é referência LÓGICA (sem FK física para `mascots`): o boundary
 * entre módulos vale também no schema — commercials não acopla seu ciclo de
 * vida ao de mascots (mesma razão do lint de boundary do .eslintrc.js).
 */
@Entity('mc_character_kits')
@Index(['userId', 'status'])
@Check('CHK_mc_kits_identity_mode', `"identityMode" = 'generated' OR "source" = 'logo'`)
export class McCharacterKit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  /**
   * Referência lógica a mascots.id — reusa direitos/identidade, sem FK física.
   * Com `source = 'logo'` aponta para a linha de `mascots` com `kind = 'logo'`
   * (o logo registrado como personagem de origem, D5). Segue NOT NULL.
   */
  @Column({ type: 'uuid' })
  mascotId: string;

  /** Origem do personagem (D5): mascote enviado ou logo da marca. Imutável após a aprovação. */
  @Column({ type: 'varchar', length: 10, default: 'mascot' })
  source: McKitSource;

  /** Estilo de render fixo do kit; NULL nos kits anteriores à change ("herdado"). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  style: McKitStyle | null;

  /** `generated` ou `logo_as_is` (este só com `source = 'logo'`, CHECK no banco). */
  @Column({ type: 'varchar', length: 12, default: 'generated' })
  identityMode: McKitIdentityMode;

  /** Identidade estilizada: candidato escolhido (logo) ou referência frontal canônica (mascote). */
  @Column({ type: 'uuid', nullable: true })
  identityAssetId: string | null;

  /** Tile do personagem (recorte da identidade com alfa), gerado na aprovação (D1). */
  @Column({ type: 'uuid', nullable: true })
  tileAssetId: string | null;

  /** Cor de fundo padrão do tile e do slot frontal das referências (#RRGGBB ou #RRGGBBAA). */
  @Column({ type: 'varchar', length: 9, nullable: true })
  tileBackgroundColor: string | null;

  /** Rodada corrente de candidatos de mascotização (mc_kit_candidates.roundId). */
  @Column({ type: 'uuid', nullable: true })
  candidateRoundId: string | null;

  @Column({ type: 'varchar', length: 20, default: McKitStatus.GENERATING })
  status: McKitStatus;

  /** Descrição canônica do personagem (vai em todo prompt de cena, §4). */
  @Column({ type: 'text', nullable: true })
  canonicalDesc: string | null;

  /** Voz fixa do mascote no provider de TTS (a voz é o ativo, §5.3). */
  @Column({ type: 'text', nullable: true })
  voiceId: string | null;

  /** Ajuste de entrega da voz (velocidade/expressividade) escolhido na aprovação; null = global. */
  @Column({ type: 'jsonb', nullable: true })
  voiceDelivery: McVoiceDeliveryOverride | null;

  /** Assets de referência (kind `kit_reference` na animation_assets, §6.1). */
  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  referenceAssetIds: string[];

  @Column({ type: 'uuid', nullable: true })
  cutoutAssetId: string | null;

  /** Imutável após approved: mudou o mascote → nova versão (plano §6.3). */
  @Column({ type: 'int', default: 1 })
  version: number;

  /** Resultado auditado da moderação (omni-moderation, plano §6.8). */
  @Column({ type: 'jsonb', nullable: true })
  moderation: Record<string, unknown> | null;

  /**
   * Gate de boca legível (D4): veredito sobre o logo cru (criação), sobre a
   * identidade (antes da aprovação) e o aceite de risco registrado.
   */
  @Column({ type: 'jsonb', nullable: true })
  mouthGate: McKitMouthGate | null;

  /**
   * Custo de fornecedor do kit (tarefa 2.6), em US$: soma das chamadas pagas
   * (descrição canônica, referências pelo modelo efetivo, gate de boca,
   * candidatos, variante com boca, traduções), incrementada a cada chamada;
   * cada uma fica também como evento `provider_cost` em `mc_events`
   * (services/mc-kit-costs.ts). Número na entidade (transformer da coluna numeric).
   */
  @Column({ type: 'numeric', precision: 12, scale: 6, default: 0, transformer: usdColumn })
  providerCostUsd: number;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;
}
