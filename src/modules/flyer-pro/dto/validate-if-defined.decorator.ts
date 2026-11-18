import { ValidateIf } from 'class-validator';

/**
 * Campo opcional que só é conferido quando o corpo o traz: ausente passa; `null` (e tudo o mais) cai nos validadores
 * seguintes e vira 400. É o contrário de `@IsOptional()`, que deixa o `null` passar e pula as outras regras
 * (L-24): aqui nenhum campo tem "sem valor", cada um é um comando.
 */
export const ValidateIfDefined = (): PropertyDecorator =>
  ValidateIf((_, value) => value !== undefined);
