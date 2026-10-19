export interface IdGenerator {
  next(): number;
}

export class SequenceIdGenerator implements IdGenerator {
  private current: number;

  constructor(start: number) {
    this.current = start;
  }

  next(): number {
    return this.current++;
  }
}
