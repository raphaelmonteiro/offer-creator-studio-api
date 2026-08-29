import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Criação de kit — fluxo REAL (plano §4): valida mascote (direitos + recorte),
 * modera a imagem ANTES de gastar e dispara a geração das referências na fila
 * mc.image. A descrição canônica é GERADA pelo worker — não entra mais aqui.
 */
export class CreateKitDto {
  /** Referência lógica a mascots.id (sem FK física — plano §6.1). */
  @IsUUID()
  mascotId: string;

  /** Voz permanente do mascote (providerVoiceId do voice_catalog). Pode ser definida depois, no approve. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  voiceId?: string;
}
