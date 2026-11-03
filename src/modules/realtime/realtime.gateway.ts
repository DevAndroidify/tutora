import { Logger, Module, type INestApplicationContext } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayConnection,
} from '@nestjs/websockets';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions, Socket } from 'socket.io';
import { AppConfig } from '../../platform/config/app-config';
import type { ClientAppName } from '../../platform/http/request-context';
import { TokenService } from '../identity/auth/token.service';
import { IdentityModule } from '../identity/identity.module';
import { UsersService } from '../identity/users.service';
import { RequestsModule } from '../requests/requests.module';
import { RequestsService } from '../requests/requests.service';
import { TutorsModule } from '../tutors/tutors.module';
import { TutorsService } from '../tutors/tutors.service';
import { BookingService } from '../sessions/booking.service';
import { SessionsModule } from '../sessions/sessions.module';
import {
  ADMIN_MODERATION_ROOM,
  REALTIME_NAMESPACE,
  parseRoom,
  requestOwnerRoom,
  requestTutorsRoom,
  sessionRoom,
  userRoom,
} from './rooms';

interface SocketUser {
  id: string;
  app: ClientAppName;
  staffRole: 'ADMIN' | 'MODERATOR' | null;
}

type Ack = { ok: true; room: string } | { ok: false; error: string };

/**
 * Socket.IO entry point. WebSockets only announce changes that REST already saved.
 * Clients connect to /realtime with `auth: { token }` (an access token from their app) and
 * are joined to their own user room automatically. Request rooms must be asked for with
 * `subscribe` and are checked: owners only for `:owner`, eligible tutors only for `:tutors`.
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE, cors: { origin: true } })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly requests: RequestsService,
    private readonly tutors: TutorsService,
    private readonly booking: BookingService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = (client.handshake.auth as { token?: unknown } | undefined)?.token;
    const claims = typeof token === 'string' ? await this.tokens.verifyAccessToken(token) : null;
    const user = claims ? await this.users.findById(claims.sub) : null;
    const fits =
      user &&
      user.status === 'ACTIVE' &&
      (claims!.aud === 'admin' ? user.accountType === 'STAFF' : user.accountType === 'MEMBER');
    if (!claims || !user || !fits) {
      client.emit('error', { code: 'UNAUTHENTICATED', message: 'Invalid or expired token.' });
      client.disconnect(true);
      return;
    }
    const socketUser: SocketUser = { id: user.id, app: claims.aud, staffRole: user.staffRole };
    client.data.user = socketUser;
    await client.join(userRoom(claims.aud, user.id));
    if (claims.aud === 'admin') await client.join(ADMIN_MODERATION_ROOM);
    client.emit('ready', { app: claims.aud, userId: user.id });
  }

  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { room?: unknown },
  ): Promise<Ack> {
    const user = client.data.user as SocketUser | undefined;
    if (!user) return { ok: false, error: 'UNAUTHENTICATED' };
    const parsed = typeof body?.room === 'string' ? parseRoom(body.room) : null;
    if (!parsed) return { ok: false, error: 'UNKNOWN_ROOM' };

    if (parsed.kind === 'session') {
      // Session rooms: the assigned tutor and paid learners only.
      const session = await this.booking.getSession(parsed.sessionId);
      const parts = session ? await this.booking.participantsOf(session.id) : [];
      const member =
        session &&
        ((user.app === 'tutor' && session.tutorUserId === user.id) ||
          (user.app === 'student' &&
            parts.some(
              (p) =>
                p.studentUserId === user.id &&
                ['CONFIRMED', 'JOINED', 'ATTENDED'].includes(p.status),
            )));
      if (!member) return { ok: false, error: 'FORBIDDEN' };
      const room = sessionRoom(session.id);
      await client.join(room);
      return { ok: true, room };
    }

    const request = await this.requests.find(parsed.requestId);
    if (!request) return { ok: false, error: 'FORBIDDEN' };

    if (parsed.kind === 'request-owner') {
      if (user.app !== 'student' || request.studentUserId !== user.id)
        return { ok: false, error: 'FORBIDDEN' };
      const room = requestOwnerRoom(request.id);
      await client.join(room);
      return { ok: true, room };
    }

    const eligible =
      user.app === 'tutor' &&
      request.status === 'OPEN' &&
      request.studentUserId !== user.id &&
      (await this.tutors.canTeach(user.id, request.skillId));
    if (!eligible) return { ok: false, error: 'FORBIDDEN' };
    const room = requestTutorsRoom(request.id);
    await client.join(room);
    return { ok: true, room };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { room?: unknown },
  ): Promise<Ack> {
    if (typeof body?.room !== 'string' || !parseRoom(body.room))
      return { ok: false, error: 'UNKNOWN_ROOM' };
    await client.leave(body.room);
    return { ok: true, room: body.room };
  }
}

/**
 * Socket.IO server with the Redis adapter, so events emitted by the worker (via the
 * Redis emitter) reach clients connected to any API instance.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(app: INestApplicationContext) {
    super(app);
    const url = app.get(AppConfig).redis.url;
    this.pub = new Redis(url, { lazyConnect: false, disconnectTimeout: 500 });
    this.sub = this.pub.duplicate();
    for (const c of [this.pub, this.sub]) c.on('error', () => undefined);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  override async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.all([closeRedis(this.pub), closeRedis(this.sub)]);
  }
}

/**
 * quit() lets pending pub/sub commands finish (disconnect() would reject them), but it never
 * resolves while Redis is unreachable, so fall back to disconnect() after a short wait.
 */
async function closeRedis(client: Redis): Promise<void> {
  if (client.status === 'connecting' || client.status === 'connect') {
    // Closing mid-handshake makes ioredis reject its connect promise; let it settle (briefly).
    await Promise.race([
      new Promise<void>((resolve) => {
        client.once('ready', () => resolve());
        client.once('end', () => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref()),
    ]);
  }
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }
  const timer = new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref());
  await Promise.race([client.quit().catch(() => undefined), timer]);
  client.disconnect();
}

@Module({
  imports: [IdentityModule, RequestsModule, TutorsModule, SessionsModule],
  providers: [RealtimeGateway],
})
export class RealtimeGatewayModule {}
