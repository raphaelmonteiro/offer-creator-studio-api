import { QueryFailedError } from 'typeorm';

/** O nome da chave única da `creationKey` na migration M1. */
export const CREATION_KEY_INDEX = 'UQ_flyer_pro_documents_creation_key';

/** Os campos que o pedido de criação traz; o pipe pula o corpo `{}`, então o serviço os confere. */
export const CREATE_REQUIRED_FIELDS = [
  'creationKey',
  'name',
  'clientId',
  'sceneId',
  'schemaVersion',
  'engineVersion',
] as const;

/** Os obrigatórios que o corpo não traz (ausentes ou nulos), na ordem do contrato. */
export function missingCreateFields(body: Record<string, unknown>): string[] {
  return CREATE_REQUIRED_FIELDS.filter(
    (field) => body?.[field] === undefined || body[field] === null,
  );
}

/** `23505` da chave única da `creationKey`: outra criação com a mesma chave passou na frente. */
export function isCreationKeyConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driver = error.driverError as { code?: string; constraint?: string } | undefined;
  return driver?.code === '23505' && driver?.constraint === CREATION_KEY_INDEX;
}
