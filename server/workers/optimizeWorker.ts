import { parentPort } from 'worker_threads';
import { optimizeStock } from '../lib/autoResearch.js';

if (parentPort) {
  parentPort.on('message', (task) => {
    const taskId = task?.taskId;
    try {
      const { rows, strategy, benchmark, options } = task;
      const result = optimizeStock(rows, strategy, benchmark, options);
      parentPort!.postMessage({ taskId, success: true, data: result });
    } catch (error: any) {
      parentPort!.postMessage({ taskId, success: false, error: error.message });
    }
  });
}
