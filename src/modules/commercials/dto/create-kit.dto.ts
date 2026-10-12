import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { MC_KIT_SOURCES, MC_KIT_STYLES, McKitSource, McKitStyle } from '../domain/mc-kit-identity';

/**
 * Criação de kit — fluxo REAL (plano §4): valida a origem (mascote ou logo,
 * com direitos + imagem), modera a imagem ANTES de gastar e, na origem
 * mascote, dispara a geração das referências na fila mc.image. A descrição
 * canônica é GERADA pelo worker — não entra mais aqui.
 *
 * Forma (400 pelo pipe global): `source` obrigatório; `style` opcional só na
 * criação (gerar referências sem estilo é regra de negócio → 422
 * STYLE_REQUIRED); `mascotId` exigido só com `source = 'mascot'`; para `logo`,
 * `clientId` OU `logoMascotId` (exatamente um — regra do service, 422).
 */
export class CreateKitDto {
  /** Origem do personagem (D5): `mascot` (mascote enviado) ou `logo` (logo da marca). */
  @IsIn(MC_KIT_SOURCES)
  source: McKitSource;

  /** Estilo de render fixo do kit; imutável depois (outro estilo = outro kit). */
  @IsOptional()
  @IsIn(MC_KIT_STYLES)
  style?: McKitStyle;

  /** Referência lógica a mascots.id (sem FK física — plano §6.1). Obrigatório com `source = 'mascot'`. */
  @ValidateIf((o: CreateKitDto) => o.source === 'mascot')
  @IsUUID()
  mascotId?: string;

  /** `source = 'logo'`: cliente cujo `logoUrl` cadastrado vira o personagem de origem. */
  @ValidateIf((o: CreateKitDto) => o.source === 'logo')
  @IsOptional()
  @IsUUID()
  clientId?: string;

  /** `source = 'logo'`: logo já registrado em `mascots` (`kind = 'logo'`). */
  @ValidateIf((o: CreateKitDto) => o.source === 'logo')
  @IsOptional()
  @IsUUID()
  logoMascotId?: string;

  /**
   * Declaração de titularidade/licença da marca para o logo registrado a
   * partir de `clientId` (mesmo aceite do `POST /mascots/:id/rights`). Sem
   * ela o kit é recusado com 422 LOGO_RIGHTS_REQUIRED.
   */
  @IsOptional()
  @IsBoolean()
  rightsConfirmed?: boolean;

  /** Voz permanente do mascote (providerVoiceId do voice_catalog). Pode ser definida depois, no approve. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  voiceId?: string;

  /**
   * Cor de fundo liso do tile e do slot frontal (`#RRGGBB`/`#RRGGBBAA`): cor
   * de marca quando a UI oferece; sem ela, kit de logo usa cinza claro e kit
   * de mascote segue o prompt legado.
   */
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, {
    message: 'tileBackgroundColor deve ser uma cor hex (#RRGGBB ou #RRGGBBAA).',
  })
  tileBackgroundColor?: string;
}
