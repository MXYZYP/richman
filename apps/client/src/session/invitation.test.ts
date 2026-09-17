import { describe, expect, it, vi } from 'vitest';
import { createInvitationQrPayload, createInvitationUrl, createInvitationUrlString, parseInvitationRoom } from './invitation';

describe('room invitations', () => {
  it('creates a canonical invitation URL with only the room query parameter', () => {
    const source = new URL('https://richman.example/game/table?playerId=player-1&token=secret&room=9999#resume');

    const invitation = createInvitationUrl(source, '1234');

    expect(invitation.href).toBe('https://richman.example/game/table?room=1234');
    expect([...invitation.searchParams.entries()]).toEqual([['room', '1234']]);
    expect(invitation.hash).toBe('');
    expect(invitation.href).not.toMatch(/token|playerId|requestId|nickname|secret/i);
  });
  it('preserves the source origin and double-slash pathname', () => {
    const source = new URL('https://richman.example//attacker.example/lobby?token=secret#x');

    const invitation = createInvitationUrl(source, '1234');

    expect(invitation.origin).toBe('https://richman.example');
    expect(invitation.pathname).toBe('//attacker.example/lobby');
    expect(invitation.search).toBe('?room=1234');
    expect(invitation.hash).toBe('');
  });


  it('parses a four-digit room code after removing whitespace from an invitation URL', () => {
    expect(parseInvitationRoom(new URL('https://richman.example/game?room=12%2034'))).toBe('1234');
    expect(parseInvitationRoom(new URL('https://richman.example/game?room=%20%2012%2034%20%20'))).toBe('1234');
    expect(parseInvitationRoom(new URL('https://richman.example/game?room=1%09%202%0A3%0D4'))).toBe('1234');
    expect(parseInvitationRoom(new URL('https://richman.example/game?room=%200123%20'))).toBe('0123');
    expect(parseInvitationRoom(new URL('https://richman.example/game?room=%20%20'))).toBeNull();
    expect(parseInvitationRoom(new URL('https://richman.example/game?room=%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94'))).toBeNull();
    expect(parseInvitationRoom(new URL('https://richman.example/game?room=12ab'))).toBeNull();
    expect(parseInvitationRoom(new URL('https://richman.example/game?room=12345'))).toBeNull();
    expect(parseInvitationRoom(new URL('https://richman.example/game?room=123'))).toBeNull();
    expect(parseInvitationRoom(new URL('https://richman.example/game?token=secret'))).toBeNull();
    expect(parseInvitationRoom(new URL('https://richman.example/game?room=12%E3%80%8034'))).toBeNull();
  });

  it('passes the exact canonical URL to the injected QR encoder without secrets', () => {
    const source = new URL('https://richman.example/game?token=secret&playerId=p1#private');
    const encode = vi.fn((text: string) => `encoded:${text}`);

    const payload = createInvitationQrPayload(source, '5678', encode);

    const expectedUrl = createInvitationUrl(source, '5678');
    expect(encode).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledWith(expectedUrl.href);
    expect(payload).toBe(`encoded:${expectedUrl.href}`);
    expect(JSON.stringify(payload)).not.toMatch(/token|playerId|requestId|nickname|secret/i);
  });

  it('shares one canonical string between the copy affordance and the injected QR encoder', () => {
    const source = new URL('https://richman.example/game/table?token=secret&playerId=p1&requestId=r1&nickname=n#resume');
    const encode = vi.fn((text: string) => `qr:${text}`);

    const copyText = createInvitationUrlString(source, '0007');
    const payload = createInvitationQrPayload(source, '0007', encode);

    expect(copyText).toBe('https://richman.example/game/table?room=0007');
    expect(encode).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledWith(copyText);
    expect(payload).toBe(`qr:${copyText}`);
    expect(copyText).not.toMatch(/token|playerId|requestId|nickname|secret/i);
    expect(JSON.stringify(payload)).not.toMatch(/token|playerId|requestId|nickname|secret/i);
  });

  it.each(['123', '12345', '12a4', '    '])('rejects non-room codes when creating invitations: %s', (roomCode) => {
    expect(() => createInvitationUrl(new URL('https://richman.example/game'), roomCode)).toThrow(RangeError);
  });
});
