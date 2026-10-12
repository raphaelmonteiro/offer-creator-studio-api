import { Brackets, FindOptionsWhere, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { VoiceCatalogEntry } from './voice-catalog.entity';

/**
 * Visibilidade de vozes por tenant (change video-formatos-personagem, D10):
 *
 *   enabled AND (curated OR ownerUserId = :userId)
 *
 * Um ÚNICO predicado para as duas superfícies que listam/validam vozes —
 * `McVoicesService` (commercials) e `VoiceCatalogController` (animations) —
 * que não podem se importar (boundary do .eslintrc.js), por isso mora em
 * src/shared/. Voz não curada e sem dono (Voice Library, clone antigo da
 * conta) fica oculta para todos até um admin marcá-la como `curated`.
 *
 * Guarda importante: `userId` vazio NUNCA abre o ramo do dono. No TypeORM,
 * `{ ownerUserId: undefined }` é interpretado como "sem condição" e devolveria
 * a tabela inteira — por isso o ramo só é emitido com um userId válido.
 */

/** Campos mínimos que o predicado precisa — aceita a entity ou um objeto parcial. */
export type VoiceVisibilityRow = Pick<VoiceCatalogEntry, 'enabled' | 'curated' | 'ownerUserId'>;

export type VoiceCatalogWhere = FindOptionsWhere<VoiceCatalogEntry>;

/** Predicado puro, em memória (mesma regra do SQL). */
export function voiceVisibleTo(
  row: VoiceVisibilityRow,
  userId: string | null | undefined,
): boolean {
  if (row.enabled !== true) return false;
  if (row.curated === true) return true;
  return Boolean(userId) && row.ownerUserId != null && row.ownerUserId === userId;
}

/**
 * Versão `where` do TypeORM (find/findOne): cada alternativa recebida vira
 * duas — curada OU do usuário — sempre com `enabled: true`. Aceita um objeto
 * (uma alternativa) ou um array (OR entre alternativas, como o resolve por
 * id/providerVoiceId usa). Sem `userId`, só o ramo curado é emitido.
 */
export function voiceVisibilityWhere(
  userId: string | null | undefined,
  where: VoiceCatalogWhere | VoiceCatalogWhere[] = {},
): VoiceCatalogWhere[] {
  const alternatives = Array.isArray(where) ? where : [where];
  const base = alternatives.length > 0 ? alternatives : [{}];
  const out: VoiceCatalogWhere[] = [];
  for (const alt of base) {
    out.push({ ...alt, enabled: true, curated: true });
    if (userId) out.push({ ...alt, enabled: true, ownerUserId: userId });
  }
  return out;
}

/**
 * Versão query builder: `andWhere` com a mesma regra, sobre o alias da
 * entity (padrão: alias principal do builder). O parâmetro leva prefixo
 * próprio para não colidir com `:userId` de quem chama.
 */
export function applyVoiceVisibilityToQuery<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  userId: string | null | undefined,
  alias: string = qb.alias,
): SelectQueryBuilder<T> {
  qb.andWhere(`${alias}.enabled = true`);
  if (!userId) return qb.andWhere(`${alias}.curated = true`);
  return qb.andWhere(
    new Brackets((b) => {
      b.where(`${alias}.curated = true`).orWhere(`${alias}.ownerUserId = :voiceVisibilityUserId`, {
        voiceVisibilityUserId: userId,
      });
    }),
  );
}

/** Guarda genérica em `T` para que os dois ramos de `applyVoiceVisibility` estreitem o tipo. */
function isQueryBuilder<T extends ObjectLiteral>(
  value: SelectQueryBuilder<T> | VoiceCatalogWhere | VoiceCatalogWhere[],
): value is SelectQueryBuilder<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as SelectQueryBuilder<T>).andWhere === 'function' &&
    typeof (value as SelectQueryBuilder<T>).alias === 'string'
  );
}

/**
 * Entrada única: recebe um `SelectQueryBuilder` (aplica `andWhere` e devolve o
 * builder) ou um `where` de find/findOne (devolve o array de alternativas).
 */
export function applyVoiceVisibility<T extends ObjectLiteral>(
  target: SelectQueryBuilder<T>,
  userId: string | null | undefined,
): SelectQueryBuilder<T>;
export function applyVoiceVisibility(
  target: VoiceCatalogWhere | VoiceCatalogWhere[],
  userId: string | null | undefined,
): VoiceCatalogWhere[];
export function applyVoiceVisibility<T extends ObjectLiteral>(
  target: SelectQueryBuilder<T> | VoiceCatalogWhere | VoiceCatalogWhere[],
  userId: string | null | undefined,
): SelectQueryBuilder<T> | VoiceCatalogWhere[] {
  if (isQueryBuilder(target)) return applyVoiceVisibilityToQuery(target, userId);
  return voiceVisibilityWhere(userId, target);
}
