import { IsBoolean } from 'class-validator';

/** Kill-switch operacional (plano §6.7): true pausa a criação de comerciais. */
export class AdminPauseDto {
  @IsBoolean()
  paused: boolean;
}
