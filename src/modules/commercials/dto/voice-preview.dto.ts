import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Preview de voz (plano §4: "aprovação da voz — frase de teste"). Texto curto: preview, não produção. */
export class VoicePreviewDto {
  /** providerVoiceId (ElevenLabs) — normalmente vindo do GET /commercials/voices. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  voiceId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  text: string;
}
