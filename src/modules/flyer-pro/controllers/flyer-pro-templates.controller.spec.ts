import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import type { FlyerProTemplatesService } from '../services/flyer-pro-templates.service';
import { FlyerProTemplatesController } from './flyer-pro-templates.controller';

describe('FlyerProTemplatesController', () => {
  it('é GET /flyer-pro/templates (o prefixo /v1 vem do app) e exige o guard JWT', () => {
    expect(Reflect.getMetadata(PATH_METADATA, FlyerProTemplatesController)).toBe(
      'flyer-pro/templates',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, FlyerProTemplatesController)).toEqual([
      JwtAuthGuard,
    ]);
  });

  it('repassa a query ao serviço e devolve o que ele devolve', async () => {
    const page = { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
    const list = jest.fn().mockResolvedValue(page);
    const controller = new FlyerProTemplatesController({
      list,
    } as unknown as FlyerProTemplatesService);
    const query = { format: '27x40' as const, search: 'a' };
    await expect(controller.list(query)).resolves.toBe(page);
    expect(list).toHaveBeenCalledWith(query);
  });
});
