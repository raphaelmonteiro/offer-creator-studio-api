import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsHexColor,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { BACKGROUND_MODES, MASCOT_PRESETS, MOTION_INTENSITIES } from '../domain/mascot-prompt';

export enum AnimationTaskType {
  BACKGROUND_VIDEO = 'background_video',
  MASCOT_MOTION = 'mascot_motion',
  TALKING_MASCOT = 'talking_mascot',
  VOICE_TTS = 'voice_tts',
}

export class BackgroundVideoInputDto {
  @IsString()
  @Length(3, 2000)
  prompt: string;

  @IsOptional()
  @IsUUID()
  referenceAssetId?: string;

  @IsOptional()
  @IsIn(['openai', 'runway_gen4'])
  baseImageEngine?: string;

  @IsIn(['9:16', '1:1', '4:5', '16:9'])
  aspectRatio: string;

  @IsInt()
  @Min(3)
  @Max(10)
  durationS: number;

  @IsIn(['subtle', 'medium', 'strong'])
  motionIntensity: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  styleHint?: string;
}

export class MascotMotionInputDto {
  /**
   * Mascote da biblioteca (`mascots.id`). O servidor resolve a imagem a partir
   * dele — o cliente NUNCA manda URL, para não abrir SSRF.
   * Alternativa: `sourceAssetId`, um asset da biblioteca de animações.
   */
  @ValidateIf((o: MascotMotionInputDto) => !o.sourceAssetId)
  @IsUUID('4', { message: 'Escolha um mascote da biblioteca.' })
  mascotId?: string;

  @ValidateIf((o: MascotMotionInputDto) => !o.mascotId)
  @IsUUID()
  sourceAssetId?: string;

  /** Preset de movimento — vira configuração de prompt, não código separado. */
  @IsIn(MASCOT_PRESETS, {
    message: `preset deve ser um de: ${MASCOT_PRESETS.join(', ')}.`,
  })
  preset: string;

  /** Texto livre do usuário. Soma ao preset, não o substitui. */
  @IsOptional()
  @IsString()
  @MaxLength(600, { message: 'A descrição do movimento não pode passar de 600 caracteres.' })
  prompt?: string;

  @IsIn(['fal_kling', 'runway'])
  engine: string;

  @IsInt()
  @Min(3)
  @Max(10)
  durationS: number;

  @IsIn(MOTION_INTENSITIES)
  intensity: string;

  @IsOptional()
  @IsIn(['9:16', '1:1', '4:5', '16:9'])
  aspectRatio?: string;

  /** Câmera parada. Default do produto: true. */
  @IsOptional()
  @IsBoolean()
  fixedCamera?: boolean;

  /** Exceção autorizada à preservação de identidade (TDD i2v §7.1). */
  @IsOptional()
  @IsBoolean()
  removeHandheldObjects?: boolean;

  /** Transparência fica fora desta entrega (TDD i2v §7.2). */
  @IsOptional()
  @IsIn(BACKGROUND_MODES)
  backgroundMode?: string;

  @IsOptional()
  @IsHexColor()
  backgroundColor?: string;
}

export class TalkingMascotInputDto {
  @IsUUID()
  sourceAssetId: string;

  @IsString()
  @Length(1, 600)
  speechText: string;

  @IsString()
  voiceId: string;

  @IsIn(['pt-BR', 'en', 'es'])
  language: string;

  @IsIn(['heygen_avatar', 'fal_kling_cartoon'])
  engine: string;
}

export class VoiceTtsInputDto {
  @IsString()
  @Length(1, 600)
  speechText: string;

  @IsString()
  voiceId: string;

  @IsIn(['pt-BR', 'en', 'es'])
  language: string;
}

const INPUT_DTO_BY_TYPE = {
  [AnimationTaskType.BACKGROUND_VIDEO]: BackgroundVideoInputDto,
  [AnimationTaskType.MASCOT_MOTION]: MascotMotionInputDto,
  [AnimationTaskType.TALKING_MASCOT]: TalkingMascotInputDto,
  [AnimationTaskType.VOICE_TTS]: VoiceTtsInputDto,
} as const;

export class CreateAnimationTaskDto {
  @IsEnum(AnimationTaskType)
  type: AnimationTaskType;

  @ValidateNested()
  @Type((opts) => {
    const type = (opts?.object as CreateAnimationTaskDto | undefined)?.type;
    return (type && INPUT_DTO_BY_TYPE[type]) || BackgroundVideoInputDto;
  })
  input: BackgroundVideoInputDto | MascotMotionInputDto | TalkingMascotInputDto | VoiceTtsInputDto;
}
