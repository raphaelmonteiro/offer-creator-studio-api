import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Exige `users.role = 'admin'`. Roda DEPOIS do JwtAuthGuard global, que já
 * colocou `{ id, email, role }` em `request.user`.
 */
@Injectable()
export class AdminRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: { role?: string } }>();
    if (request.user?.role !== 'admin') {
      throw new ForbiddenException('Acesso restrito a administradores');
    }
    return true;
  }
}
