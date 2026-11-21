import { OutboxScheduler } from './outbox.scheduler';
import { OutboxService } from './outbox.service';

describe('OutboxScheduler', () => {
  let scheduler: OutboxScheduler;
  let outboxService: {
    dispatchPending: jest.Mock;
  };

  beforeEach(() => {
    outboxService = {
      dispatchPending: jest.fn(),
    };

    scheduler = new OutboxScheduler(outboxService as unknown as OutboxService);
  });

  it('should dispatch pending events', async () => {
    outboxService.dispatchPending.mockResolvedValue({
      skipped: false,
      processed: 1,
      published: 1,
      failed: 0,
      leaseLost: 0,
    });

    await scheduler.dispatchOutboxEvents();

    expect(outboxService.dispatchPending).toHaveBeenCalledTimes(1);
  });

  it('should prevent overlapping executions', async () => {
    let resolveDispatch!: (value: unknown) => void;

    outboxService.dispatchPending.mockReturnValue(
      new Promise((resolve) => {
        resolveDispatch = resolve;
      }),
    );

    const firstExecution = scheduler.dispatchOutboxEvents();

    await scheduler.dispatchOutboxEvents();

    expect(outboxService.dispatchPending).toHaveBeenCalledTimes(1);

    resolveDispatch({
      skipped: false,
      processed: 0,
      published: 0,
      failed: 0,
      leaseLost: 0,
    });

    await firstExecution;
  });

  it('should recover after a dispatch error', async () => {
    outboxService.dispatchPending
      .mockRejectedValueOnce(new Error('Database unavailable'))
      .mockResolvedValueOnce({
        skipped: false,
        processed: 0,
        published: 0,
        failed: 0,
        leaseLost: 0,
      });

    await expect(scheduler.dispatchOutboxEvents()).resolves.toBeUndefined();

    await expect(scheduler.dispatchOutboxEvents()).resolves.toBeUndefined();

    expect(outboxService.dispatchPending).toHaveBeenCalledTimes(2);
  });
});
