import { Injectable, Module } from '@nestjs/common';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database } from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import type { MemberApp } from '../identity/identity.schema';
import { notifications, type NotificationRow } from './notifications.schema';

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NewNotification {
  userId: string;
  app: MemberApp | null;
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  sourceEventId: number;
}

const toView = (n: NotificationRow): NotificationView => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  data: n.data,
  readAt: n.readAt?.toISOString() ?? null,
  createdAt: n.createdAt.toISOString(),
});

@Injectable()
export class NotificationsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /** Idempotent per (event, user). Returns the notification, or null if it already existed. */
  async create(input: NewNotification): Promise<NotificationView | null> {
    const [row] = await this.db
      .insert(notifications)
      .values({
        userId: input.userId,
        app: input.app,
        type: input.type,
        title: input.title,
        body: input.body ?? '',
        data: input.data ?? {},
        sourceEventId: input.sourceEventId,
        createdAt: this.clock.now(),
      })
      .onConflictDoNothing()
      .returning();
    return row ? toView(row) : null;
  }

  async list(user: AuthUser, unreadOnly: boolean): Promise<NotificationView[]> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, user.id),
          or(isNull(notifications.app), eq(notifications.app, user.app as MemberApp)),
          unreadOnly ? isNull(notifications.readAt) : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    return rows.map(toView);
  }

  async markRead(user: AuthUser, id: string): Promise<NotificationView> {
    const [row] = await this.db
      .update(notifications)
      .set({ readAt: this.clock.now() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, user.id)))
      .returning();
    if (!row) throw AppError.notFound('NOTIFICATION_NOT_FOUND', 'Notification not found.');
    return toView(row);
  }
}

@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
