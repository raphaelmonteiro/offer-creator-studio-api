import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/** Confere o `x-admin-token` contra `ADMIN_API_TOKEN` (403 se ausente ou diferente). */
export function assertAdminToken(expected: string | undefined, token: string | undefined): void {
  if (!expected) throw new ForbiddenException('ADMIN_API_TOKEN não configurado no servidor.');
  if (!token || token !== expected) throw new ForbiddenException('Token administrativo inválido.');
}

/**
 * Guard que roda antes dos interceptors: numa rota com upload, o token é
 * validado antes de o multer ler o arquivo.
 */
@Injectable()
export class DotcompanyAdminTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['x-admin-token'];
    assertAdminToken(
      this.config.get<string>('ADMIN_API_TOKEN'),
      Array.isArray(header) ? header[0] : header,
    );
    return true;
  }
}
