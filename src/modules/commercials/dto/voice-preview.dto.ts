import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MC_VOICE_SPEED_RANGE } from '../domain/mc-voice-delivery';

/** Ajuste de entrega da voz escolhido pelo usuário (velocidade/expressividade). */
export class VoiceDeliveryDto {
  @IsOptional()
  @IsNumber()
  @Min(MC_VOICE_SPEED_RANGE.min)
  @Max(MC_VOICE_SPEED_RANGE.max)
  speed?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  style?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  stability?: number;
}

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

  /** Mesmo ajuste que será gravado no kit — a amostra é o que a cena vai falar. */
  @IsOptional()
  @ValidateNested()
  @Type(() => VoiceDeliveryDto)
  delivery?: VoiceDeliveryDto;
}
