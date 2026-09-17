export interface LocalStartGuard {
  begin(): number;
  cancel(): void;
  isCurrent(ticket: number): boolean;
}

export function createLocalStartGuard(): LocalStartGuard {
  let generation = 0;

  return {
    begin() {
      generation += 1;
      return generation;
    },
    cancel() {
      generation += 1;
    },
    isCurrent(ticket) {
      return ticket === generation;
    },
  };
}
