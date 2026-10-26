import type { LocalSaveCard, LocalSaveObservedRecord } from '../session/localGameSave';

export interface LocalDeleteConfirmation {
  readonly key: string;
  readonly observed: LocalSaveObservedRecord;
}

export interface LocalDeleteRequest {
  readonly confirmation: LocalDeleteConfirmation | null;
  readonly observed: LocalSaveObservedRecord | null;
}

export function localCardKey(card: LocalSaveCard): string {
  return card.kind === 'valid'
    ? `slot-${card.summary.slot}-game-${card.summary.gameId}`
    : `slot-${card.slot}`;
}

export function requestLocalDelete(
  confirmation: LocalDeleteConfirmation | null,
  card: LocalSaveCard,
): LocalDeleteRequest {
  const observed = card.kind === 'valid'
    ? { slot: card.summary.slot, recordToken: card.summary.recordToken }
    : card.recordToken === undefined
      ? null
      : { slot: card.slot, recordToken: card.recordToken };
  if (observed === null) return { confirmation: null, observed: null };

  const key = localCardKey(card);
  if (confirmation?.key !== key) {
    return { confirmation: { key, observed }, observed: null };
  }
  return { confirmation: null, observed: confirmation.observed };
}
