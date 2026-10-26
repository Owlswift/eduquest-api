import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from '../../auth/dto/register.dto';
import { UpdateProfileDto } from './update-profile.dto';

const check = async <T extends object>(cls: new () => T, body: object) => {
  const dto = plainToInstance(cls, body);
  return { dto, errors: await validate(dto as object, { whitelist: true, forbidNonWhitelisted: true }) };
};

describe('state validation', () => {
  it.each([
    ['lagos', 'Lagos'],
    ['Lagos State', 'Lagos'],
    ['abuja', 'FCT'],
    ['CROSS RIVER', 'Cross River'],
  ])('profile update stores %s as %s', async (input, stored) => {
    const { dto, errors } = await check(UpdateProfileDto, { state: input });
    expect(errors).toHaveLength(0);
    expect(dto.state).toBe(stored);
  });

  it('rejects something that is not a Nigerian state', async () => {
    const { errors } = await check(UpdateProfileDto, { state: 'Accra' });
    expect(errors[0].constraints?.isIn).toMatch(/Nigerian state/);
  });

  it('registration stores the canonical spelling, not a lowercased one', async () => {
    const { dto, errors } = await check(RegisterDto, { name: 'Ada', email: 'a@b.co', password: 'secret1', state: 'Lagos' });
    expect(errors).toHaveLength(0);
    expect(dto.state).toBe('Lagos');
  });

  it('registration treats a blank picker as not chosen', async () => {
    const { dto, errors } = await check(RegisterDto, { name: 'Ada', email: 'a@b.co', password: 'secret1', state: '  ' });
    expect(errors).toHaveLength(0);
    expect(dto.state).toBeUndefined();
  });

  it('registration rejects an unknown state', async () => {
    const { errors } = await check(RegisterDto, { name: 'Ada', email: 'a@b.co', password: 'secret1', state: 'Narnia' });
    expect(errors).toHaveLength(1);
  });

  it('caps the number of subjects', async () => {
    const { errors } = await check(UpdateProfileDto, { subjects: Array.from({ length: 13 }, (_, i) => `s${i}`) });
    expect(errors).toHaveLength(1);
  });
});
