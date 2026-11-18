import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

/** Ajudante dos specs de DTO do salvar (só testes): os caminhos recusados, aninhados, como o pipe global os confere. */

/** Os caminhos das propriedades recusadas, no fim da árvore (`import.fileHash`, `setup.name`, `items.upsert`). */
export function pathsOf(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((error) => {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    return error.children?.length ? pathsOf(error.children, path) : [path];
  });
}

/** Valida o corpo com o mesmo `whitelist` e `forbidNonWhitelisted` do pipe global e devolve os caminhos recusados. */
export async function nestedErrorsOf<T extends object>(
  dto: ClassConstructor<T>,
  body: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(dto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return pathsOf(errors);
}
