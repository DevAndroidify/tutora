/** Socket.IO namespace shared by all apps. */
export const REALTIME_NAMESPACE = '/realtime';

export const userRoom = (app: 'student' | 'tutor' | 'admin', userId: string) =>
  `user:${app}:${userId}`;
/** Only the learner who owns the request. Receives full bids (with prices). */
export const requestOwnerRoom = (requestId: string) => `request:${requestId}:owner`;
/** Tutors eligible to bid. Receives bid counts only, never prices. */
export const requestTutorsRoom = (requestId: string) => `request:${requestId}:tutors`;
export const sessionRoom = (sessionId: string) => `session:${sessionId}`;
export const ADMIN_MODERATION_ROOM = 'admin:moderation';

export type RoomRequest =
  | { kind: 'request-owner'; requestId: string }
  | { kind: 'request-tutors'; requestId: string }
  | { kind: 'session'; sessionId: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REQUEST_ROOM = new RegExp(`^request:(${UUID}):(owner|tutors)$`, 'i');
const SESSION_ROOM = new RegExp(`^session:(${UUID})$`, 'i');

/** Parses a room name a client asked to join. Only request and session rooms are joinable on demand. */
export function parseRoom(room: string): RoomRequest | null {
  const s = SESSION_ROOM.exec(room);
  if (s) return { kind: 'session', sessionId: s[1]! };
  const m = REQUEST_ROOM.exec(room);
  if (!m) return null;
  return m[2] === 'owner'
    ? { kind: 'request-owner', requestId: m[1]! }
    : { kind: 'request-tutors', requestId: m[1]! };
}
