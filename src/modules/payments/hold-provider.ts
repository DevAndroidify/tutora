/**
 * Where held money physically sits until release.
 *
 * - `ledger_only` (default): the platform's internal ledger tracks the hold; payouts are recorded
 *   manually (UPI) by admins. No provider calls.
 * - `razorpay_route` (optional, off by default): the tutor's share is transferred to their Razorpay
 *   Route linked account with `on_hold: true`, released with PATCH /transfers/{id} `on_hold: false`.
 *   Requires Razorpay Route approval for the business. The platform never keeps customer money in a
 *   wallet of its own.
 */
export interface HoldTarget {
  paymentId: string;
  providerPaymentId: string;
  tutorLinkedAccountId: string | null;
  tutorSharePaise: number;
  routeTransferId: string | null;
}

export abstract class HoldProvider {
  abstract readonly mode: 'ledger_only' | 'razorpay_route';
  /** After capture: put the tutor's share on hold. Returns a transfer id when one is created. */
  abstract hold(target: HoldTarget): Promise<{ routeTransferId: string | null }>;
  abstract release(target: HoldTarget): Promise<void>;
  /** Before a refund: undo whatever hold() did. */
  abstract reverse(target: HoldTarget): Promise<void>;
}

export class LedgerOnlyHoldProvider extends HoldProvider {
  readonly mode = 'ledger_only' as const;
  async hold(): Promise<{ routeTransferId: null }> {
    return { routeTransferId: null };
  }
  async release(): Promise<void> {}
  async reverse(): Promise<void> {}
}

/** The subset of the Razorpay SDK Route methods we use (mocked in tests). */
export interface RazorpayRouteClient {
  payments: {
    transfer(
      paymentId: string,
      params: {
        transfers: Array<{
          account: string;
          amount: number;
          currency: 'INR';
          on_hold: boolean;
          notes?: Record<string, string>;
        }>;
      },
    ): Promise<{ items: Array<{ id: string }> }>;
  };
  transfers: {
    edit(
      transferId: string,
      params: { on_hold: boolean; on_hold_until?: number },
    ): Promise<{ id: string; on_hold: boolean }>;
    reverse(transferId: string, params: { amount?: number }): Promise<{ id: string }>;
  };
}

export class RazorpayRouteHoldProvider extends HoldProvider {
  readonly mode = 'razorpay_route' as const;

  constructor(private readonly client: RazorpayRouteClient) {
    super();
  }

  async hold(t: HoldTarget): Promise<{ routeTransferId: string | null }> {
    if (t.routeTransferId) return { routeTransferId: t.routeTransferId };
    if (!t.tutorLinkedAccountId) {
      throw new Error(
        `Tutor has no Razorpay linked account; payment ${t.paymentId} stays ledger-only.`,
      );
    }
    const res = await this.client.payments.transfer(t.providerPaymentId, {
      transfers: [
        {
          account: t.tutorLinkedAccountId,
          amount: t.tutorSharePaise,
          currency: 'INR',
          on_hold: true,
          notes: { paymentId: t.paymentId },
        },
      ],
    });
    return { routeTransferId: res.items[0]?.id ?? null };
  }

  async release(t: HoldTarget): Promise<void> {
    if (t.routeTransferId) await this.client.transfers.edit(t.routeTransferId, { on_hold: false });
  }

  async reverse(t: HoldTarget): Promise<void> {
    if (t.routeTransferId)
      await this.client.transfers.reverse(t.routeTransferId, { amount: t.tutorSharePaise });
  }
}
