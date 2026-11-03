/**
 * Every table, for Drizzle's typed client. Modules still only query their own tables.
 */
export * from '../audit/audit.schema';
export * from '../idempotency/idempotency.schema';
export * from '../outbox/outbox.schema';
export * from '../../modules/identity/identity.schema';
export * from '../../modules/catalog/catalog.schema';
export * from '../../modules/tutors/tutors.schema';
export * from '../../modules/moderation/moderation.schema';
export * from '../../modules/requests/requests.schema';
export * from '../../modules/bidding/bidding.schema';
export * from '../../modules/notifications/notifications.schema';
export * from '../../modules/sessions/sessions.schema';
export * from '../../modules/ledger/ledger.schema';
export * from '../../modules/payments/payments.schema';
export * from '../../providers/upi/fake-upi.schema';
export * from '../../modules/live/live.schema';
export * from '../../modules/settlement/settlement.schema';
export * from '../../modules/mastery/mastery.schema';
export * from '../../modules/recording/recording.schema';
export * from '../../modules/replay/replay.schema';
export * from '../../modules/lowbandwidth/lowbandwidth.schema';
export * from '../../modules/pooling/pooling.schema';
