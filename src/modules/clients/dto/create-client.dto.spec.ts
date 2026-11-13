import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateClientDto } from './create-client.dto';
import { UpdateClientDto } from './update-client.dto';

describe('headers nos DTOs de cliente', () => {
  it('rejeita headers que não é lista (UpdateClientDto)', async () => {
    const errors = await validate(plainToInstance(UpdateClientDto, { headers: 'abc' }));
    expect(errors.map((e) => e.property)).toContain('headers');
  });

  it('rejeita item de headers que não é objeto (CreateClientDto)', async () => {
    const errors = await validate(
      plainToInstance(CreateClientDto, { name: 'E', cnpj: '12', headers: ['x', 1] }),
    );
    expect(errors.map((e) => e.property)).toContain('headers');
  });

  it('aceita headers null e lista vazia', async () => {
    for (const headers of [null, []]) {
      const errors = await validate(
        plainToInstance(CreateClientDto, { name: 'E', cnpj: '12', headers }),
      );
      expect(errors.filter((e) => e.property === 'headers')).toHaveLength(0);
    }
  });
});
