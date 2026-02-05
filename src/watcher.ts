import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

export interface WatcherOptions {
  persistent?: boolean;
  ignoreInitial?: boolean;
  followSymlinks?: boolean;
  awaitWriteFinish?: boolean | { stabilityThreshold?: number; pollInterval?: number };
}

export interface FileChange {
  file: string;
  type: 'add' | 'change' | 'unlink';
  timestamp: Date;
  position?: number;
}

export class LogWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private filePositions: Map<string, number> = new Map();
  private files: string[] = [];

  constructor(files: string[], options: WatcherOptions = {}) {
    super();
    this.files = files.map(f => path.resolve(f));

    const watchOptions = {
      persistent: options.persistent !== false,
      ignoreInitial: options.ignoreInitial !== false,
      followSymlinks: options.followSymlinks !== false,
      awaitWriteFinish: options.awaitWriteFinish !== false
        ? {
            stabilityThreshold: 500,
            pollInterval: 100,
            ...((typeof options.awaitWriteFinish === 'object') ? options.awaitWriteFinish : {})
          }
        : false,
    };

    this.watcher = chokidar.watch(this.files, watchOptions);

    this.setupHandlers();
  }

  private setupHandlers(): void {
    if (!this.watcher) return;

    this.watcher
      .on('add', (filePath: string) => {
        this.handleFileAdd(filePath);
      })
      .on('change', (filePath: string) => {
        this.handleFileChange(filePath);
      })
      .on('unlink', (filePath: string) => {
        this.handleFileRemove(filePath);
      })
      .on('error', (error: Error) => {
        this.emit('error', error);
      })
      .on('ready', () => {
        this.emit('ready');
      });
  }

  private handleFileAdd(filePath: string): void {
    const absolutePath = path.resolve(filePath);

    try {
      const stats = fs.statSync(absolutePath);
      this.filePositions.set(absolutePath, stats.size);

      const change: FileChange = {
        file: absolutePath,
        type: 'add',
        timestamp: new Date(),
        position: stats.size
      };

      this.emit('fileAdded', change);
      this.emit('change', change);
    } catch (error) {
      this.emit('error', error);
    }
  }

  private handleFileChange(filePath: string): void {
    const absolutePath = path.resolve(filePath);

    try {
      const stats = fs.statSync(absolutePath);
      const lastPosition = this.filePositions.get(absolutePath) || 0;

      // File was truncated (log rotation)
      if (stats.size < lastPosition) {
        this.filePositions.set(absolutePath, 0);
        this.readNewContent(absolutePath, 0, stats.size);
        return;
      }

      // Read only new content
      if (stats.size > lastPosition) {
        this.readNewContent(absolutePath, lastPosition, stats.size);
      }

      this.filePositions.set(absolutePath, stats.size);
    } catch (error) {
      this.emit('error', error);
    }
  }

  private handleFileRemove(filePath: string): void {
    const absolutePath = path.resolve(filePath);
    this.filePositions.delete(absolutePath);

    const change: FileChange = {
      file: absolutePath,
      type: 'unlink',
      timestamp: new Date()
    };

    this.emit('fileRemoved', change);
    this.emit('change', change);
  }

  private readNewContent(filePath: string, start: number, end: number): void {
    const stream = fs.createReadStream(filePath, {
      start,
      end: end - 1,
      encoding: 'utf8'
    });

    let buffer = '';

    stream.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');

      // Keep the last incomplete line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          this.emit('line', {
            file: filePath,
            line: line,
            timestamp: new Date()
          });
        }
      }
    });

    stream.on('end', () => {
      // Emit the last line if there's content
      if (buffer.trim()) {
        this.emit('line', {
          file: filePath,
          line: buffer,
          timestamp: new Date()
        });
      }
    });

    stream.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  addFile(filePath: string): void {
    const absolutePath = path.resolve(filePath);
    if (!this.files.includes(absolutePath)) {
      this.files.push(absolutePath);
      this.watcher?.add(absolutePath);
    }
  }

  removeFile(filePath: string): void {
    const absolutePath = path.resolve(filePath);
    const index = this.files.indexOf(absolutePath);
    if (index !== -1) {
      this.files.splice(index, 1);
      this.watcher?.unwatch(absolutePath);
      this.filePositions.delete(absolutePath);
    }
  }

  getFiles(): string[] {
    return [...this.files];
  }

  close(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.filePositions.clear();
    this.removeAllListeners();
  }
}

export function createWatcher(files: string[], options?: WatcherOptions): LogWatcher {
  return new LogWatcher(files, options);
}
