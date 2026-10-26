import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CommercialsController } from './commercials.controller';
import { UpdateScriptV2Dto } from './dto/quality-v2.dto';
import { McEnabledGuard } from './mc-enabled.guard';
import { McPieceProjectController } from './mc-piece-project.controller';

/** Rotas tocadas por video-mascote-transparente: JWT em todas (401 sem token) e 400 por forma. */
describe('rotas do recorte do personagem', () => {
  it.each([
    ['CommercialsController', CommercialsController],
    ['McPieceProjectController', McPieceProjectController],
  ])('%s exige JWT e o módulo habilitado (401 sem token)', (_name, controller) => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, McEnabledGuard]));
  });

  it('PATCH script: framing fora de busto|corpo e cutout não booleano → 400 (forma do DTO)', async () => {
    const dto = plainToInstance(UpdateScriptV2Dto, {
      expectedRevision: 1,
      scenes: [{ sceneType: 'talk_tile', actionPrompt: '', durationS: 5 }],
      framing: 'inteiro',
      cutout: 'sim',
    });
    const errors = (await validate(dto, { whitelist: true })).map((e) => e.property);
    expect(errors).toEqual(expect.arrayContaining(['framing', 'cutout']));
    const ok = plainToInstance(UpdateScriptV2Dto, {
      expectedRevision: 1,
      scenes: [{ sceneType: 'talk_tile', actionPrompt: '', durationS: 5 }],
      framing: 'corpo',
      cutout: true,
    });
    const okErrors = (await validate(ok, { whitelist: true })).map((e) => e.property);
    expect(okErrors).not.toContain('framing');
    expect(okErrors).not.toContain('cutout');
  });
});
