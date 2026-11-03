import { FakeClock } from './clock';

describe('FakeClock', () => {
  it('only moves when told to', () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    clock.advanceMinutes(15);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:15:00.000Z');
    clock.advanceHours(24);
    expect(clock.now().toISOString()).toBe('2026-01-02T00:15:00.000Z');
    clock.advanceDays(7);
    expect(clock.now().toISOString()).toBe('2026-01-09T00:15:00.000Z');
  });
});
