import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CommercialsInsightsController } from './commercials-insights.controller';
import { AdminCostsQueryDto } from './dto/admin-costs.dto';
import { McAdminCostsService } from './services/mc-admin-costs.service';
import { McWindowPriceService } from './services/mc-window-price.service';

/**
 * Rotas derivadas (8.3 / 4.7): custos exigem x-admin-token = ADMIN_API_TOKEN
 * (mesmo padrão de admin/pause); avisos da janela delegam com o usuário.
 */
describe('CommercialsInsightsController', () => {
  let costs: { monthlyCosts: jest.Mock };
  let windowPrice: { checkOwned: jest.Mock };
  let token: string | undefined;
  let controller: CommercialsInsightsController;

  beforeEach(() => {
    token = 'segredo';
    costs = { monthlyCosts: jest.fn().mockResolvedValue({ month: '2026-10', totals: {} }) };
    windowPrice = {
      checkOwned: jest.fn().mockResolvedValue({ projectId: 'p1', warnings: [] }),
    };
    controller = new CommercialsInsightsController(
      { get: (key: string) => (key === 'ADMIN_API_TOKEN' ? token : undefined) } as ConfigService,
      costs as unknown as McAdminCostsService,
      windowPrice as unknown as McWindowPriceService,
    );
  });

  it('GET /admin/costs com o token correto delega o mês ao service', async () => {
    await expect(controller.adminCosts('segredo', { month: '2026-10' })).resolves.toMatchObject({
      month: '2026-10',
    });
    expect(costs.monthlyCosts).toHaveBeenCalledWith('2026-10');
    await controller.adminCosts('segredo', {});
    expect(costs.monthlyCosts).toHaveBeenLastCalledWith(undefined); // mês corrente no service
  });

  it('GET /admin/costs sem token, com token errado ou sem ADMIN_API_TOKEN no servidor → 403 sem consultar', () => {
    expect(() => controller.adminCosts(undefined, { month: '2026-10' })).toThrow(
      ForbiddenException,
    );
    expect(() => controller.adminCosts('outro', { month: '2026-10' })).toThrow(ForbiddenException);
    token = undefined;
    expect(() => controller.adminCosts('segredo', { month: '2026-10' })).toThrow(
      /ADMIN_API_TOKEN não configurado/,
    );
    expect(costs.monthlyCosts).not.toHaveBeenCalled();
  });

  it('AdminCostsQueryDto: YYYY-MM válido ou ausente; outros formatos → erro de validação (400 pelo pipe)', async () => {
    const errors = async (query: Record<string, unknown>) =>
      validate(plainToInstance(AdminCostsQueryDto, query));
    expect(await errors({ month: '2026-10' })).toHaveLength(0);
    expect(await errors({})).toHaveLength(0);
    expect(await errors({ month: '2026-13' })).toHaveLength(1);
    expect(await errors({ month: '2026-1' })).toHaveLength(1);
    expect(await errors({ month: 'outubro' })).toHaveLength(1);
  });

  it('GET /projects/:id/window-warnings delega com o usuário (ownership no service)', async () => {
    await expect(controller.windowWarnings({ id: 'u1' }, 'p1')).resolves.toEqual({
      projectId: 'p1',
      warnings: [],
    });
    expect(windowPrice.checkOwned).toHaveBeenCalledWith('u1', 'p1');
  });
});
