import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApproveKitDto, CandidatesRoundDto } from './kit-actions.dto';

async function errorsOf(cls: new () => object, input: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, input), { whitelist: true });
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}).map((k) => `${e.property}.${k}`));
}

describe('DTOs das ações do kit — forma (400 pelo pipe global)', () => {
  it('ApproveKitDto: acceptMouthRisk é booleano opcional', async () => {
    expect(await errorsOf(ApproveKitDto, { voiceId: 'v1' })).toEqual([]);
    expect(await errorsOf(ApproveKitDto, { voiceId: 'v1', acceptMouthRisk: true })).toEqual([]);
    expect(await errorsOf(ApproveKitDto, { acceptMouthRisk: 'sim' })).toContain(
      'acceptMouthRisk.isBoolean',
    );
  });

  it('CandidatesRoundDto: ajustes opcionais, texto até 600 caracteres', async () => {
    expect(await errorsOf(CandidatesRoundDto, {})).toEqual([]);
    expect(await errorsOf(CandidatesRoundDto, { adjustments: 'menos infantil' })).toEqual([]);
    expect(await errorsOf(CandidatesRoundDto, { adjustments: 'x'.repeat(601) })).toContain(
      'adjustments.maxLength',
    );
    expect(await errorsOf(CandidatesRoundDto, { adjustments: 42 })).toContain(
      'adjustments.isString',
    );
  });
});
