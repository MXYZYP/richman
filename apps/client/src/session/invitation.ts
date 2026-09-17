const ROOM_CODE_PATTERN = /^\d{4}$/;

export type InvitationQrEncoder<T> = (canonicalUrl: string) => T;

function isRoomCode(roomCode: string): boolean {
  return ROOM_CODE_PATTERN.test(roomCode);
}

export function createInvitationUrl(currentUrl: URL, roomCode: string): URL {
  if (!isRoomCode(roomCode)) {
    throw new RangeError('Invitation room code must be exactly four digits');
  }

  const invitationUrl = new URL(currentUrl.origin + currentUrl.pathname);
  invitationUrl.searchParams.set('room', roomCode);
  return invitationUrl;
}

export function parseInvitationRoom(url: URL): string | null {
  const roomCode = url.searchParams.get('room')?.replace(/[ \t\r\n\f\v]+/g, '');
  return roomCode !== undefined && isRoomCode(roomCode) ? roomCode : null;
}

/** The canonical invitation string — the single source shared by the copy affordance and the QR encoder. */
export function createInvitationUrlString(currentUrl: URL, roomCode: string): string {
  return createInvitationUrl(currentUrl, roomCode).href;
}

export function createInvitationQrPayload<T>(
  currentUrl: URL,
  roomCode: string,
  encode: InvitationQrEncoder<T>,
): T {
  return encode(createInvitationUrlString(currentUrl, roomCode));
}
