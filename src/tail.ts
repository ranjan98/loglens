import fs from 'fs';
import { EventEmitter } from 'events';
import readline from 'readline';
import path from 'path';

export interface TailOptions {
  lines?: number;
  follow?: boolean;
  encoding?: BufferEncoding;
}

export interface TailEvent {
  file: string;
  line: string;
  lineNumber: number;
  timestamp: Date;
}

export class LogTailer extends EventEmitter {
  private files: Map<string, number> = new Map();
  private following: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private pollDelay: number = 100; // milliseconds

  constructor() {
    super();
  }

  async tail(filePath: string, options: TailOptions = {}): Promise<void> {
    const {
      lines = 10,
      follow = false,
      encoding = 'utf8'
    } = options;

    const absolutePath = path.resolve(filePath);

    try {
      // Check if file exists
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`File not found: ${absolutePath}`);
      }

      // Read last N lines
      const lastLines = await this.readLastLines(absolutePath, lines, encoding);

      // Emit initial lines
      for (let i = 0; i < lastLines.length; i++) {
        const event: TailEvent = {
          file: absolutePath,
          line: lastLines[i],
          lineNumber: i + 1,
          timestamp: new Date()
        };
        this.emit('line', event);
      }

      // Store file position for following
      const stats = fs.statSync(absolutePath);
      this.files.set(absolutePath, stats.size);

      if (follow) {
        this.following = true;
        this.startFollowing(encoding);
      }
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async tailMultiple(filePaths: string[], options: TailOptions = {}): Promise<void> {
    const {
      lines = 10,
      follow = false,
      encoding = 'utf8'
    } = options;

    const promises = filePaths.map(async (filePath) => {
      const absolutePath = path.resolve(filePath);

      try {
        if (!fs.existsSync(absolutePath)) {
          this.emit('error', new Error(`File not found: ${absolutePath}`));
          return;
        }

        const lastLines = await this.readLastLines(absolutePath, lines, encoding);

        for (let i = 0; i < lastLines.length; i++) {
          const event: TailEvent = {
            file: absolutePath,
            line: lastLines[i],
            lineNumber: i + 1,
            timestamp: new Date()
          };
          this.emit('line', event);
        }

        const stats = fs.statSync(absolutePath);
        this.files.set(absolutePath, stats.size);
      } catch (error) {
        this.emit('error', error);
      }
    });

    await Promise.all(promises);

    if (follow) {
      this.following = true;
      this.startFollowing(encoding);
    }
  }

  private async readLastLines(
    filePath: string,
    numLines: number,
    encoding: BufferEncoding
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const stats = fs.statSync(filePath);
      const fileSize = stats.size;

      if (fileSize === 0) {
        resolve([]);
        return;
      }

      // Estimate bytes to read (assume average 80 chars per line)
      const estimatedBytes = Math.min(numLines * 120, fileSize);
      const start = Math.max(0, fileSize - estimatedBytes);

      const stream = fs.createReadStream(filePath, {
        start,
        encoding
      });

      let buffer = '';

      stream.on('data', (chunk: string) => {
        buffer += chunk;
      });

      stream.on('end', () => {
        const lines = buffer.split('\n').filter(line => line.trim() !== '');
        const lastLines = lines.slice(-numLines);
        resolve(lastLines);
      });

      stream.on('error', reject);
    });
  }

  private startFollowing(encoding: BufferEncoding): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    this.pollInterval = setInterval(() => {
      this.checkForNewContent(encoding);
    }, this.pollDelay);
  }

  private checkForNewContent(encoding: BufferEncoding): void {
    for (const [filePath, lastPosition] of this.files.entries()) {
      try {
        const stats = fs.statSync(filePath);
        const currentSize = stats.size;

        // File was truncated (log rotation)
        if (currentSize < lastPosition) {
          this.files.set(filePath, 0);
          this.readNewContent(filePath, 0, currentSize, encoding);
          continue;
        }

        // New content available
        if (currentSize > lastPosition) {
          this.readNewContent(filePath, lastPosition, currentSize, encoding);
          this.files.set(filePath, currentSize);
        }
      } catch (error) {
        // File might have been deleted
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.files.delete(filePath);
          this.emit('fileRemoved', filePath);
        } else {
          this.emit('error', error);
        }
      }
    }
  }

  private readNewContent(
    filePath: string,
    start: number,
    end: number,
    encoding: BufferEncoding
  ): void {
    const stream = fs.createReadStream(filePath, {
      start,
      end: end - 1,
      encoding
    });

    let buffer = '';
    let lineNumber = 0;

    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');

      // Keep last incomplete line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          const event: TailEvent = {
            file: filePath,
            line: line,
            lineNumber: ++lineNumber,
            timestamp: new Date()
          };
          this.emit('line', event);
        }
      }
    });

    stream.on('end', () => {
      if (buffer.trim()) {
        const event: TailEvent = {
          file: filePath,
          line: buffer,
          lineNumber: ++lineNumber,
          timestamp: new Date()
        };
        this.emit('line', event);
      }
    });

    stream.on('error', (error) => {
      this.emit('error', error);
    });
  }

  stop(): void {
    this.following = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  close(): void {
    this.stop();
    this.files.clear();
    this.removeAllListeners();
  }

  isFollowing(): boolean {
    return this.following;
  }

  getFiles(): string[] {
    return Array.from(this.files.keys());
  }
}

export function createTailer(): LogTailer {
  return new LogTailer();
}
