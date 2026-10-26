import { ordinal } from './admin-competition-results.service';

describe('ordinal', () => {
  it.each([
    [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [13, '13th'],
    [21, '21st'], [22, '22nd'], [23, '23rd'], [100, '100th'], [101, '101st'], [111, '111th'], [112, '112th'], [1003, '1003rd'],
  ])('%i is %s', (n, s) => expect(ordinal(n)).toBe(s));
});
