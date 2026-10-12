import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MC_ASPECT_RATIOS } from '../domain/mc-types';
import { CreateProjectDto } from './create-project.dto';
import { DuplicateProjectDto } from './duplicate-project.dto';

async function errorsOf(dto: object): Promise<string[]> {
  const errors = await validate(dto, { whitelist: true });
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}).map((k) => `${e.property}.${k}`));
}

const baseCreate = {
  kitId: '6f1c2a4e-5b7d-4c8e-9f0a-1b2c3d4e5f60',
  title: 'Ofertas da semana',
  briefing: 'Mascote apresenta as ofertas da semana',
  targetDurationS: 15,
};

/** Forma dos DTOs de aspecto (video-formatos-personagem, design D12): 4:5 entra na FORMA; a regra é do service. */
describe('CreateProjectDto / DuplicateProjectDto — aspectRatio com 4:5 (D12)', () => {
  it('MC_ASPECT_RATIOS tem os quatro aspectos', () => {
    expect([...MC_ASPECT_RATIOS]).toEqual(['9:16', '4:5', '1:1', '16:9']);
  });

  it.each([...MC_ASPECT_RATIOS])('CreateProjectDto aceita %s', async (aspectRatio) => {
    const dto = plainToInstance(CreateProjectDto, { ...baseCreate, aspectRatio });
    expect(await errorsOf(dto)).toEqual([]);
  });

  it('CreateProjectDto: aspectRatio é opcional (default 9:16 no service)', async () => {
    expect(await errorsOf(plainToInstance(CreateProjectDto, baseCreate))).toEqual([]);
  });

  it('CreateProjectDto rejeita aspecto fora da lista (400 pelo pipe global)', async () => {
    const dto = plainToInstance(CreateProjectDto, { ...baseCreate, aspectRatio: '4:3' });
    expect(await errorsOf(dto)).toEqual(['aspectRatio.isIn']);
  });

  it.each([...MC_ASPECT_RATIOS])('DuplicateProjectDto aceita %s', async (aspectRatio) => {
    expect(await errorsOf(plainToInstance(DuplicateProjectDto, { aspectRatio }))).toEqual([]);
  });

  it('DuplicateProjectDto: vazio copia o aspecto de origem; "4x5" é rejeitado', async () => {
    expect(await errorsOf(plainToInstance(DuplicateProjectDto, {}))).toEqual([]);
    expect(await errorsOf(plainToInstance(DuplicateProjectDto, { aspectRatio: '4x5' }))).toEqual([
      'aspectRatio.isIn',
    ]);
  });
});
