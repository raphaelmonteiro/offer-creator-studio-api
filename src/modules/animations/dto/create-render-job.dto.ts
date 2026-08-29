import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** Vídeo de um clipe sincronizado (spike §3.5). */
export class SyncedClipVideoDto {
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\/uploads\//, { message: 'url deve apontar para /uploads/*' })
  url?: string;

  @IsNumber() @Min(0) @Max(1) x: number;
  @IsNumber() @Min(0) @Max(1) y: number;
  @IsNumber() @Min(0) @Max(1) w: number;
  @IsNumber() @Min(0) @Max(1) h: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;
}

/** Áudio de um clipe sincronizado — sempre no mesmo `startMs` do vídeo. */
export class SyncedClipAudioDto {
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\/uploads\//, { message: 'url deve apontar para /uploads/*' })
  url?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  volume?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;
}

export class RenderLayerDto {
  @IsIn(['video', 'image_overlay', 'mascot', 'audio', 'synced_clip'])
  type: string;

  @IsOptional()
  @IsUUID()
  assetId?: string;

  /**
   * Alternativa a assetId — restrita a caminhos locais /uploads/* (anti-SSRF,
   * TDD §4.1). Nunca aceitar URL externa: o ffmpeg roda no servidor.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\/uploads\//, { message: 'url deve apontar para /uploads/*' })
  url?: string;

  // Em `synced_clip` a geometria vive dentro de `video` — o clipe é o objeto
  // que a UI move, e ele tem um tempo só.
  @ValidateIf((o: RenderLayerDto) => o.type !== 'synced_clip')
  @IsNumber()
  @Min(0)
  @Max(1)
  x: number;
  @ValidateIf((o: RenderLayerDto) => o.type !== 'synced_clip')
  @IsNumber()
  @Min(0)
  @Max(1)
  y: number;
  @ValidateIf((o: RenderLayerDto) => o.type !== 'synced_clip')
  @IsNumber()
  @Min(0)
  @Max(1)
  w: number;
  @ValidateIf((o: RenderLayerDto) => o.type !== 'synced_clip')
  @IsNumber()
  @Min(0)
  @Max(1)
  h: number;

  @IsInt()
  @Min(0)
  startMs: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  endMs?: number;

  @ValidateIf((o: RenderLayerDto) => o.type !== 'synced_clip')
  @IsBoolean()
  loop: boolean;

  @IsInt()
  zIndex: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  volume?: number;

  @ValidateIf((o: RenderLayerDto) => o.type === 'synced_clip')
  @ValidateNested()
  @Type(() => SyncedClipVideoDto)
  video?: SyncedClipVideoDto;

  @ValidateIf((o: RenderLayerDto) => o.type === 'synced_clip')
  @ValidateNested()
  @Type(() => SyncedClipAudioDto)
  audio?: SyncedClipAudioDto;
}

export class RenderSpecDto {
  @IsIn(['mp4', 'webm', 'gif'])
  format: string;

  @IsInt() @Min(240) @Max(2160) width: number;
  @IsInt() @Min(240) @Max(3840) height: number;

  @IsInt()
  @IsIn([12, 24, 30])
  fps: number;

  @IsInt()
  @Min(1000)
  @Max(30000)
  durationMs: number;

  @IsIn(['draft', 'standard', 'high'])
  quality: string;

  @IsOptional()
  @IsHexColor()
  backgroundColor?: string;

  @ValidateNested({ each: true })
  @Type(() => RenderLayerDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  layers: RenderLayerDto[];
}

export class CreateRenderJobDto {
  @IsOptional()
  @IsUUID()
  flyerId?: string;

  @ValidateNested()
  @Type(() => RenderSpecDto)
  spec: RenderSpecDto;
}
