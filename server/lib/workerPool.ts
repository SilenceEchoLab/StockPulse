import { Worker } from 'worker_threads';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const filename = typeof __filename !== 'undefined' ? __filename : fileURLToPath((import.meta as any).url);
const dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(filename);

// Ensure we correctly resolve the worker depending on dev (ts) vs prod (cjs)
const isProd = filename.endsWith('.cjs') || filename.endsWith('.js');
const workerPath = isProd 
  ? path.resolve(dirname, '../optimizeWorker.cjs') 
  : path.resolve(dirname, '../workers/optimizeWorker.ts');

const execArgv = isProd ? [] : ['--import', 'tsx'];

export class OptimizeWorkerPool {
  private workers: Worker[] = [];
  private taskQueue: any[] = [];
  private taskCallbacks: Map<number, { resolve: Function, reject: Function }> = new Map();
  private nextTaskId = 1;
  private freeWorkers: Worker[] = [];

  constructor(size = Math.max(1, os.cpus().length - 1)) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerPath, { execArgv });
      worker.on('message', (msg) => this.onMessage(worker, msg));
      worker.on('error', (err) => {
        console.error('Worker error', err);
        // If a worker dies, it's not currently automatically replaced in this simple implementation
      });
      this.workers.push(worker);
      this.freeWorkers.push(worker);
    }
  }

  private onMessage(worker: Worker, msg: any) {
    const { taskId, success, data, error } = msg;
    const callbacks = this.taskCallbacks.get(taskId);
    if (callbacks) {
      if (success) callbacks.resolve(data);
      else callbacks.reject(new Error(error));
      this.taskCallbacks.delete(taskId);
    }
    this.freeWorkers.push(worker);
    this.pump();
  }

  private pump() {
    if (this.taskQueue.length === 0 || this.freeWorkers.length === 0) return;
    const worker = this.freeWorkers.pop()!;
    const task = this.taskQueue.shift()!;
    worker.postMessage(task.payload);
  }

  public runTask(payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const taskId = this.nextTaskId++;
      payload.taskId = taskId;
      this.taskCallbacks.set(taskId, { resolve, reject });
      this.taskQueue.push({ payload });
      this.pump();
    });
  }

  public close() {
    this.workers.forEach(w => w.terminate());
  }
}

// Global instance
export const optimizeWorkerPool = new OptimizeWorkerPool();
