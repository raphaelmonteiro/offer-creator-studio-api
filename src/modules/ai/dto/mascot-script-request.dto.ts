import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const MASCOT_SCRIPT_TONES = ['animado', 'institucional'] as const;
export type MascotScriptTone = (typeof MASCOT_SCRIPT_TONES)[number];

/**
 * POST /v1/ai/mascot-script (spike §4) — roteiro de locução a partir das
 * ofertas REAIS do encarte. O texto volta sempre editável: nada vira áudio
 * sem o usuário ver.
 */
export class MascotScriptRequestDto {
  @IsUUID('4', { message: 'flyerId inválido.' })
  flyerId: string;

  @IsIn(MASCOT_SCRIPT_TONES, {
    message: `tone deve ser um de: ${MASCOT_SCRIPT_TONES.join(', ')}.`,
  })
  tone: MascotScriptTone;

  /** Duração alvo da locução. O teto duro é `MAX_VIDEO_DURATION_S`. */
  @IsInt({ message: 'maxSeconds deve ser um número inteiro de segundos.' })
  @Min(5, { message: 'A locução precisa de pelo menos 5 segundos.' })
  @Max(60, { message: 'A locução não pode passar de 60 segundos.' })
  maxSeconds: number;

  /** Quantas ofertas citar. Default calculado pela duração. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  maxProducts?: number;

  /** Chamada final ("só até domingo", "corre no Zé"). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  callToAction?: string;
}
