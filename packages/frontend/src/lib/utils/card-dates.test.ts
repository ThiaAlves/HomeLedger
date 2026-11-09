import { describe, it, expect } from 'vitest';
import { firstCardDue } from './card-dates';
describe('first card statement suggestion', () => {
  it('moves purchases on closing day to the next cycle', () => {
    expect(firstCardDue('2026-11-04', 5, 15)).toBe('2026-11-15');
    expect(firstCardDue('2026-11-05', 5, 15)).toBe('2026-12-15');
  });
  it('handles due days before closing, year rollover and short months', () => {
    expect(firstCardDue('2026-12-25', 20, 10)).toBe('2027-02-10');
    expect(firstCardDue('2026-02-01', 5, 31)).toBe('2026-02-28');
  });
});

describe('closing days in short months', () => {
  it('clamps closing day before deciding the cycle', () => {
    expect(firstCardDue('2026-02-27', 31, 5)).toBe('2026-03-05');
    expect(firstCardDue('2026-02-28', 31, 5)).toBe('2026-04-05');
    expect(firstCardDue('2028-02-29', 31, 5)).toBe('2028-04-05');
  });
});
