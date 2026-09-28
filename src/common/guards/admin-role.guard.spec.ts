import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminRoleGuard } from './admin-role.guard';

const ctx = (user?: { role?: string }) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

describe('AdminRoleGuard', () => {
  const guard = new AdminRoleGuard();
  it('libera admin', () => expect(guard.canActivate(ctx({ role: 'admin' }))).toBe(true));
  it('barra usuário comum com 403', () =>
    expect(() => guard.canActivate(ctx({ role: 'user' }))).toThrow(ForbiddenException));
  it('barra requisição sem usuário', () =>
    expect(() => guard.canActivate(ctx())).toThrow(ForbiddenException));
});
