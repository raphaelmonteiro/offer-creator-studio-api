import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { publishJobBatch } from './flyer-pro-job.queue';

describe('publishJobBatch', () => {
  const manager = { query: jest.fn() };
  const message = { jobId: 'job-1', seq: 3 };

  function publishWith(options: { expireInSeconds: number; startAfterSeconds?: number }) {
    const queue = { publish: jest.fn().mockResolvedValue('queue-job') };
    return publishJobBatch(queue as never, manager as never, message, options).then(() => queue);
  }

  it('publica na fila do job, na transação, com retryLimit 0 e o prazo de expiração', async () => {
    const queue = await publishWith({ expireInSeconds: 900 });

    expect(queue.publish).toHaveBeenCalledWith(QUEUES.FLYER_PRO_ENRICH, message, {
      manager,
      retryLimit: 0,
      expireInSeconds: 900,
    });
  });

  it('a espera só vai às opções quando é maior que zero', async () => {
    const waiting = await publishWith({ expireInSeconds: 900, startAfterSeconds: 15 });
    const none = await publishWith({ expireInSeconds: 900, startAfterSeconds: 0 });

    expect(waiting.publish.mock.calls[0][2]).toMatchObject({ startAfterSeconds: 15 });
    expect(none.publish.mock.calls[0][2]).not.toHaveProperty('startAfterSeconds');
  });
});
