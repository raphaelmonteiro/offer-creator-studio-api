import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateFlyerProCursorDto } from './update-flyer-pro-cursor.dto';

async function errorsOf(body: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(UpdateFlyerProCursorDto, body);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}

describe('UpdateFlyerProCursorDto', () => {
  it('aceita só a etapa e a etapa com o estado de tela', async () => {
    expect(await errorsOf({ step: 'card' })).toEqual([]);
    expect(await errorsOf({ step: 'assembly', ui: { assemblyZoom: 3 } })).toEqual([]);
    expect(await errorsOf({ step: 'assembly', ui: null })).toEqual([]);
  });

  it.each([
    ['step', 'foo'],
    ['step', 3],
    ['ui', [1]],
    ['ui', 'texto'],
  ])('recusa %s=%p', async (field, value) => {
    expect(await errorsOf({ step: 'card', [field]: value })).toEqual([field]);
  });

  it('campo desconhecido é recusado, e step ausente também', async () => {
    expect(await errorsOf({ step: 'card', revision: 3 })).toEqual(['revision']);
    expect(await errorsOf({ ui: {} })).toEqual(['step']);
  });
});
