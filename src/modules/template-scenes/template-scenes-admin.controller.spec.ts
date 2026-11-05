import { ConfigService } from '@nestjs/config';
import { UploadsGcService } from '../../shared/gc/uploads-gc.service';
import { TemplateScenesAdminController } from './template-scenes-admin.controller';

describe('TemplateScenesAdminController', () => {
  const summary = { selected: 1, deleted: 1, dryRun: false, files: ['/uploads/template-scenes/a'] };
  const build = (adminToken?: string) => {
    const gc = { runTemplateScenes: jest.fn().mockResolvedValue(summary) };
    const config = new ConfigService(adminToken ? { ADMIN_API_TOKEN: adminToken } : {});
    return {
      gc,
      controller: new TemplateScenesAdminController(gc as unknown as UploadsGcService, config),
    };
  };
  const statusOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as { getStatus(): number }).getStatus();
    }
    return 200;
  };

  it('com token válido executa a limpeza e devolve a seleção', () => {
    const { controller, gc } = build('segredo');
    expect(controller.runGc('segredo', { dryRun: false })).resolves.toEqual(summary);
    expect(gc.runTemplateScenes).toHaveBeenCalledWith({ dryRun: false });
  });

  it('dryRun ausente passa undefined (vale TEMPLATE_SCENE_GC_DRY_RUN)', async () => {
    const { controller, gc } = build('segredo');
    await controller.runGc('segredo', {});
    expect(gc.runTemplateScenes).toHaveBeenCalledWith({ dryRun: undefined });
  });

  it.each([
    ['sem header', undefined],
    ['token errado', 'outro'],
    ['token de outro tamanho', 'segredo-mais-longo'],
    ['token vazio', ''],
  ])('%s: 401 e nada roda', (_label, token) => {
    const { controller, gc } = build('segredo');
    expect(statusOf(() => controller.runGc(token, {}))).toBe(401);
    expect(gc.runTemplateScenes).not.toHaveBeenCalled();
  });

  it('sem ADMIN_API_TOKEN no servidor a rota fica fechada, mesmo com header', () => {
    const { controller, gc } = build();
    expect(statusOf(() => controller.runGc('qualquer', {}))).toBe(401);
    expect(gc.runTemplateScenes).not.toHaveBeenCalled();
  });
});
