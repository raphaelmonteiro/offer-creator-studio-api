import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MC_MAX_SCENES, MC_SCENE_MAX_S, MC_SCENE_MIN_S } from '../domain/mc-director';
import { MC_MAX_SEAL_PRODUCTS } from '../domain/mc-types';

/** Uma cena do roteiro editado. `dialogue` ausente/null = cena muda (plano §6.1). */
export class ScriptSceneDto {
  @IsInt()
  @Min(0)
  idx: number;

  @IsString()
  @Length(3, 2000)
  actionPrompt: string;

  /**
   * Ação em inglês (McScript v2) — opcional na edição: quando o usuário reescreve
   * só o texto em pt e não manda a versão EN, o motor cai no `actionPrompt`
   * (ver `sceneActionPromptEn`), sem quebrar o roteiro.
   */
  @IsOptional()
  @IsString()
  @Length(3, 2000)
  actionPromptEn?: string;

  @IsOptional()
  @IsString()
  @Length(1, 1000)
  dialogue?: string | null;

  /** Cenas de 4–12s (contrato v1-B1); 3 e 30 ficam como folga de compatibilidade. */
  @IsInt()
  @Min(3)
  @Max(30)
  durationS: number;
}

/** Produto do selo determinístico (plano §5.4) — nome + preço prontos. */
export class SealProductDto {
  @IsString()
  @Length(1, 60)
  name: string;

  @IsString()
  @Length(1, 20)
  price: string;
}

/**
 * Selo determinístico da montagem (plano §5.4). `products` é o formato v1-B1
 * (1 selo por cena, rotativo); `text` continua aceito (selo único da v0).
 */
export class ScriptSealDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  text?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MC_MAX_SEAL_PRODUCTS)
  @ValidateNested({ each: true })
  @Type(() => SealProductDto)
  products?: SealProductDto[];
}

/** Cartela final (2s) com o nome do estabelecimento. */
export class ScriptEndcardDto {
  @IsString()
  @Length(1, 60)
  storeName: string;
}

/**
 * PATCH /commercials/projects/:id/script — substitui o roteiro em
 * storyboard_review (o usuário edita fala/ação antes de aprovar). O idx
 * efetivo é normalizado pela POSIÇÃO no array (ordem de montagem).
 */
export class UpdateScriptDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MC_MAX_SCENES)
  @ValidateNested({ each: true })
  @Type(() => ScriptSceneDto)
  scenes: ScriptSceneDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ScriptSealDto)
  seal?: ScriptSealDto | null;

  /** Omitir PRESERVA a cartela atual do roteiro; `null` remove. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ScriptEndcardDto)
  endcard?: ScriptEndcardDto | null;
}

/** PATCH /commercials/projects/:id/scenes/:idx/dialogue — regravar a fala (plano §6.3). */
export class UpdateDialogueDto {
  @IsString()
  @Length(1, 1000)
  dialogue: string;
}

// Constantes reexportadas para quem valida durações fora do DTO.
export { MC_SCENE_MAX_S, MC_SCENE_MIN_S };
