import { Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';
import { AppConfig } from '../../platform/config/app-config';
import type { OutboxEvent } from '../../platform/outbox/outbox.service';
import type { BidEventPayload } from '../bidding/bidding.service';
import {
  NotificationsModule,
  NotificationsService,
  type NewNotification,
} from '../notifications/notifications.service';
import {
  ADMIN_MODERATION_ROOM,
  REALTIME_NAMESPACE,
  requestOwnerRoom,
  requestTutorsRoom,
  sessionRoom,
  userRoom,
} from './rooms';

/** Sends one Socket.IO event to the union of the given rooms. */
export abstract class RealtimeEmitter {
  abstract emit(rooms: string[], event: string, data: unknown): void;
}

export const REALTIME_REDIS = Symbol('REALTIME_REDIS');

@Injectable()
export class RedisRealtimeEmitter extends RealtimeEmitter {
  private readonly emitter: Emitter;

  constructor(@Inject(REALTIME_REDIS) redis: Redis) {
    super();
    this.emitter = new Emitter(redis);
  }

  emit(rooms: string[], event: string, data: unknown): void {
    if (rooms.length === 0) return;
    this.emitter.of(REALTIME_NAMESPACE).to(rooms).emit(event, data);
  }
}

@Injectable()
class RealtimeRedisCloser implements OnApplicationShutdown {
  constructor(@Inject(REALTIME_REDIS) private readonly redis: Redis) {}
  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

/**
 * Turns saved domain events into deliveries: socket events to the right rooms and
 * in-app notifications. This is where "tutors never see rival prices" is enforced:
 * the tutors room only ever gets the bid count.
 */
@Injectable()
export class RealtimeRouter {
  private readonly logger = new Logger(RealtimeRouter.name);

  constructor(
    private readonly out: RealtimeEmitter,
    private readonly notifications: NotificationsService,
  ) {}

  async handle(event: OutboxEvent): Promise<void> {
    const p = event.payload;
    switch (event.type) {
      case 'bid.created':
      case 'bid.updated':
      case 'bid.withdrawn': {
        const b = p as BidEventPayload;
        const ownerData = {
          eventId: event.id,
          requestId: b.requestId,
          bidCount: b.bidCount,
          bid: b.ownerBid,
        };
        this.out.emit(
          [userRoom('student', b.studentUserId), requestOwnerRoom(b.requestId)],
          event.type,
          ownerData,
        );
        this.out.emit([userRoom('tutor', b.tutorUserId)], event.type, ownerData); // the bidder's own bid
        this.out.emit([requestTutorsRoom(b.requestId)], 'request.bid_count_changed', {
          eventId: event.id,
          requestId: b.requestId,
          bidCount: b.bidCount,
        });
        if (event.type === 'bid.created') {
          await this.notify({
            userId: b.studentUserId,
            app: 'student',
            type: 'bid.received',
            title: 'New bid on your request',
            data: { requestId: b.requestId, bidId: b.bidId },
            sourceEventId: event.id,
          });
        }
        return;
      }

      case 'request.closed': {
        const requestId = String(p.requestId);
        const data = { eventId: event.id, requestId, status: p.status };
        this.out.emit(
          [
            userRoom('student', String(p.studentUserId)),
            requestOwnerRoom(requestId),
            requestTutorsRoom(requestId),
          ],
          'request.closed',
          data,
        );
        return;
      }

      case 'moderation.action_taken': {
        await this.notify({
          userId: String(p.userId),
          app: null,
          type: 'moderation.action',
          title: actionTitle(String(p.action)),
          body: String(p.reason ?? ''),
          data: { action: p.action, endsAt: p.endsAt ?? null },
          sourceEventId: event.id,
        });
        return;
      }

      case 'moderation.case_updated':
        this.out.emit([ADMIN_MODERATION_ROOM], 'moderation.case_updated', {
          eventId: event.id,
          ...p,
        });
        return;

      case 'bid.accepted': {
        const tutorId = String(p.tutorUserId);
        this.out.emit([userRoom('tutor', tutorId)], 'bid.accepted', { eventId: event.id, ...p });
        await this.notify({
          userId: tutorId,
          app: 'tutor',
          type: 'bid.accepted',
          title: 'Your bid was accepted. Waiting for payment.',
          data: { requestId: p.requestId, sessionId: p.sessionId },
          sourceEventId: event.id,
        });
        return;
      }

      case 'booking.payment_expired': {
        const data = { eventId: event.id, ...p };
        this.out.emit(
          [userRoom('student', String(p.studentUserId))],
          'booking.payment_expired',
          data,
        );
        if (p.tutorUserId)
          this.out.emit(
            [userRoom('tutor', String(p.tutorUserId))],
            'booking.payment_expired',
            data,
          );
        this.out.emit([requestTutorsRoom(String(p.requestId))], 'request.reopened', {
          eventId: event.id,
          requestId: p.requestId,
        });
        return;
      }

      case 'session.scheduled': {
        for (const [app, id] of [
          ['student', p.studentUserId],
          ['tutor', p.tutorUserId],
        ] as const) {
          if (!id) continue;
          await this.notify({
            userId: String(id),
            app,
            type: 'session.scheduled',
            title: 'Payment received. Your session is booked.',
            data: { sessionId: p.sessionId, startsAt: p.startsAt },
            sourceEventId: event.id,
          });
        }
        return;
      }

      case 'payment.refunded':
        await this.notify({
          userId: String(p.studentUserId),
          app: 'student',
          type: 'payment.refunded',
          title: 'Your payment was refunded',
          body: String(p.reason ?? ''),
          data: { paymentId: p.paymentId, amountPaise: p.amountPaise },
          sourceEventId: event.id,
        });
        return;

      case 'session.status_changed':
      case 'session.participant_joined':
        this.out.emit([sessionRoom(String(p.sessionId))], event.type, { eventId: event.id, ...p });
        return;

      case 'session.no_show': {
        for (const id of (p.studentUserIds as string[] | undefined) ?? []) {
          await this.notify({
            userId: id,
            app: 'student',
            type: 'session.no_show',
            title:
              'Your tutor did not join. You will get a full refund and your request is open again.',
            data: { sessionId: p.sessionId },
            sourceEventId: event.id,
          });
        }
        return;
      }

      case 'payment.released':
        await this.notify({
          userId: String(p.tutorUserId),
          app: 'tutor',
          type: 'payment.released',
          title: 'Earnings released',
          data: { paymentId: p.paymentId, tutorSharePaise: p.tutorSharePaise },
          sourceEventId: event.id,
        });
        return;

      case 'dispute.opened':
        this.out.emit([ADMIN_MODERATION_ROOM], 'dispute.opened', { eventId: event.id, ...p });
        return;

      case 'replay.transcript_ready':
        this.out.emit([sessionRoom(String(p.sessionId))], 'replay.ready', {
          eventId: event.id,
          sessionId: p.sessionId,
        });
        return;

      case 'pool.offer_accepted':
        await this.notify({
          userId: String(p.tutorUserId),
          app: 'tutor',
          type: 'pool.offer_accepted',
          title: 'A group accepted your offer. Waiting for learners to pay.',
          data: { poolId: p.poolId, sessionId: p.sessionId },
          sourceEventId: event.id,
        });
        return;

      case 'pool.expired':
        for (const id of (p.studentUserIds as string[] | undefined) ?? []) {
          await this.notify({
            userId: id,
            app: 'student',
            type: 'pool.expired',
            title: 'Not enough people paid for the group session. Any payment will be refunded.',
            data: { poolId: p.poolId },
            sourceEventId: event.id,
          });
        }
        return;

      case 'pool.invited':
        await this.notify({
          userId: String(p.studentUserId),
          app: 'student',
          type: 'pool.invited',
          title: 'Others asked something very similar. Join a cheaper group session?',
          data: { poolId: p.poolId, inviteId: p.inviteId },
          sourceEventId: event.id,
        });
        return;

      case 'payments.alert':
        this.out.emit([ADMIN_MODERATION_ROOM], 'payments.alert', { eventId: event.id, ...p });
        return;

      case 'request.published':
        // Matching-tutor alerts come with pooling/notifications preferences later.
        return;

      default:
        this.logger.debug(`No route for event ${event.type}; skipping.`);
    }
  }

  private async notify(input: NewNotification): Promise<void> {
    const created = await this.notifications.create(input);
    if (!created) return; // already delivered on an earlier attempt
    const rooms = input.app
      ? [userRoom(input.app, input.userId)]
      : [userRoom('student', input.userId), userRoom('tutor', input.userId)];
    this.out.emit(rooms, 'notification.created', created);
  }
}

function actionTitle(action: string): string {
  switch (action) {
    case 'WARN':
      return 'You received a warning';
    case 'RESTRICT_POSTING':
      return 'Posting is temporarily restricted';
    case 'RESTRICT_BIDDING':
      return 'Bidding is temporarily restricted';
    default:
      return 'Action taken on your account';
  }
}

/** Router + emitter, used by the worker (and by tests to drive delivery). */
@Module({
  imports: [NotificationsModule],
  providers: [
    {
      provide: REALTIME_REDIS,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => {
        const r = new Redis(config.redis.url, { disconnectTimeout: 500 });
        r.on('error', () => undefined);
        return r;
      },
    },
    RealtimeRedisCloser,
    { provide: RealtimeEmitter, useClass: RedisRealtimeEmitter },
    RealtimeRouter,
  ],
  exports: [RealtimeRouter, RealtimeEmitter],
})
export class RealtimeRouterModule {}
