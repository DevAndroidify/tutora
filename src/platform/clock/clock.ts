import { Global, Injectable, Module } from '@nestjs/common';

/**
 * All time-based logic must read time from here so tests can control it.
 */
export abstract class Clock {
  abstract now(): Date;

  nowMs(): number {
    return this.now().getTime();
  }
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock that only moves when told to. Use in tests. */
export class FakeClock extends Clock {
  private current: number;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    super();
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }

  advanceHours(hours: number): void {
    this.advance(hours * 3_600_000);
  }

  advanceDays(days: number): void {
    this.advance(days * 86_400_000);
  }
}

@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class ClockModule {}
