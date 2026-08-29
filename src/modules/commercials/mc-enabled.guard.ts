import { CanActivate, HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * Feature flag do módulo (Fase 0): com MC_ENABLED !== 'true' as rotas
 * respondem 404 MC_DISABLED — o módulo fica sempre registrado no app, mas
 * invisível até o go-live. O consumer da fila tem o mesmo gate no
 * CommercialsModule.onModuleInit.
 */
@Injectable()
export class McEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env.MC_ENABLED !== 'true') {
      throw new HttpException(
        { code: 'MC_DISABLED', message: 'Recurso não disponível' },
        HttpStatus.NOT_FOUND,
      );
    }
    return true;
  }
}
