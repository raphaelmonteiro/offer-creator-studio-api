import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

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
  @IsUUID()
  sourceAssetId: string;

  @IsIn(['wave', 'dance', 'point', 'enter_side', 'idle_bounce'])
  motion: string;

  @IsIn(['fal_kling', 'runway'])
  engine: string;

  @IsInt()
  @Min(3)
  @Max(10)
  durationS: number;

  @IsIn(['subtle', 'medium', 'strong'])
  intensity: string;
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
