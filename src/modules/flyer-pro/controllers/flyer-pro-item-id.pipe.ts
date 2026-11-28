import { ParseUUIDPipe } from '@nestjs/common';
import { flyerProBadRequest } from '../domain/flyer-pro.errors';

/** `:itemId` que não é UUID: 400 `BAD_REQUEST` (o encarte inválido é 404, pelo `DocumentIdPipe`, que vem antes). */
export const ItemIdPipe = new ParseUUIDPipe({
  exceptionFactory: () => flyerProBadRequest('Identificador do item inválido.'),
});
