import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { ForApp } from '../../platform/http/request-context';
import { StaffRoles } from '../../modules/identity/auth/guards';
import { LedgerService } from '../../modules/ledger/ledger.service';
import { PAYMENT_STATUSES } from '../../modules/payments/payments.schema';
import { PaymentsService } from '../../modules/payments/payments.service';

class PaymentListQuery {
  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  status?: (typeof PAYMENT_STATUSES)[number];
}

@ApiTags('admin: payments and ledger')
@ApiBearerAuth()
@ForApp('admin')
@StaffRoles('ADMIN')
@Controller('admin')
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly ledger: LedgerService,
  ) {}

  @Get('payments')
  @ApiOperation({ summary: 'Recent payments.' })
  list(@Query() q: PaymentListQuery) {
    return this.payments.list(q.status);
  }

  @Get('ledger/balances')
  @ApiOperation({ summary: 'Balance of every ledger account (paise).' })
  balances() {
    return this.ledger.balances();
  }

  @Get('ledger/reconciliation')
  @ApiOperation({
    summary: 'Debits vs credits across the whole ledger; lists any unbalanced transaction.',
  })
  reconcile() {
    return this.ledger.reconcile();
  }
}
