import express, { Express, Request, Response } from 'express';
import { Server as WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { LogWatcher } from './watcher';
import { LogFilter, FilterOptions, createDefaultFilter } from './filters';

export interface DashboardOptions {
  port?: number;
  host?: string;
  files: string[];
  filterOptions?: FilterOptions;
}

export class Dashboard {
  private app: Express;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private watcher: LogWatcher | null = null;
  private filter: LogFilter;
  private clients: Set<WebSocket> = new Set();
  private port: number;
  private host: string;
  private files: string[];
  private logBuffer: Array<{ file: string; line: string; timestamp: string }> = [];
  private maxBufferSize: number = 1000;

  constructor(options: DashboardOptions) {
    this.port = options.port || 3000;
    this.host = options.host || 'localhost';
    this.files = options.files;
    this.filter = createDefaultFilter(options.filterOptions);
    this.app = express();

    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Serve static HTML
    this.app.get('/', (req: Request, res: Response) => {
      res.send(this.getHTML());
    });

    // API endpoint for current log files
    this.app.get('/api/files', (req: Request, res: Response) => {
      res.json({
        files: this.files,
        count: this.files.length
      });
    });

    // API endpoint for log buffer
    this.app.get('/api/logs', (req: Request, res: Response) => {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = this.logBuffer.slice(-limit);
      res.json({ logs });
    });

    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        files: this.files.length,
        clients: this.clients.size
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create HTTP server
        this.server = http.createServer(this.app);

        // Setup WebSocket server
        this.wss = new WebSocketServer({ server: this.server });
        this.setupWebSocket();

        // Setup file watcher
        this.watcher = new LogWatcher(this.files, {
          persistent: true,
          ignoreInitial: false
        });
        this.setupWatcher();

        // Start listening
        this.server.listen(this.port, this.host, () => {
          console.log(`Dashboard running at http://${this.host}:${this.port}`);
          resolve();
        });

        this.server.on('error', reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  private setupWebSocket(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('Client connected');
      this.clients.add(ws);

      // Send initial buffer
      const initialData = {
        type: 'init',
        logs: this.logBuffer.slice(-100),
        files: this.files
      };
      ws.send(JSON.stringify(initialData));

      ws.on('close', () => {
        console.log('Client disconnected');
        this.clients.delete(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });
    });
  }

  private setupWatcher(): void {
    if (!this.watcher) return;

    this.watcher.on('line', (data: { file: string; line: string; timestamp: Date }) => {
      // Apply filtering
      if (!this.filter.shouldInclude(data.line)) {
        return;
      }

      const parsed = this.filter.parseLogLine(data.line, path.basename(data.file));

      const logEntry = {
        file: path.basename(data.file),
        line: data.line,
        timestamp: data.timestamp.toISOString(),
        level: parsed.level,
        parsedTimestamp: parsed.timestamp
      };

      // Add to buffer
      this.logBuffer.push(logEntry);
      if (this.logBuffer.length > this.maxBufferSize) {
        this.logBuffer.shift();
      }

      // Broadcast to all connected clients
      this.broadcast({
        type: 'log',
        data: logEntry
      });
    });

    this.watcher.on('fileAdded', (change) => {
      this.broadcast({
        type: 'file_added',
        file: path.basename(change.file)
      });
    });

    this.watcher.on('fileRemoved', (change) => {
      this.broadcast({
        type: 'file_removed',
        file: path.basename(change.file)
      });
    });

    this.watcher.on('error', (error) => {
      console.error('Watcher error:', error);
      this.broadcast({
        type: 'error',
        message: error.message
      });
    });
  }

  private broadcast(message: any): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private getHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LogLens Dashboard</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      background: #1e1e1e;
      color: #d4d4d4;
      font-size: 13px;
      line-height: 1.5;
    }

    .header {
      background: #252526;
      border-bottom: 1px solid #3e3e42;
      padding: 12px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header h1 {
      font-size: 18px;
      font-weight: 600;
      color: #cccccc;
    }

    .header-info {
      display: flex;
      gap: 20px;
      align-items: center;
      font-size: 12px;
      color: #858585;
    }

    .status {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4ec9b0;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .controls {
      background: #252526;
      border-bottom: 1px solid #3e3e42;
      padding: 10px 20px;
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .controls button {
      background: #0e639c;
      color: white;
      border: none;
      padding: 6px 14px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      transition: background 0.2s;
    }

    .controls button:hover {
      background: #1177bb;
    }

    .controls button.secondary {
      background: #3e3e42;
    }

    .controls button.secondary:hover {
      background: #4e4e52;
    }

    .controls input {
      background: #3c3c3c;
      border: 1px solid #3e3e42;
      color: #cccccc;
      padding: 6px 10px;
      border-radius: 3px;
      font-family: inherit;
      font-size: 12px;
      min-width: 200px;
    }

    .controls input:focus {
      outline: none;
      border-color: #0e639c;
    }

    .controls label {
      font-size: 12px;
      color: #cccccc;
    }

    .main {
      height: calc(100vh - 100px);
      overflow: hidden;
    }

    .log-container {
      height: 100%;
      overflow-y: auto;
      padding: 10px 20px;
      background: #1e1e1e;
    }

    .log-line {
      padding: 3px 8px;
      margin: 2px 0;
      border-radius: 2px;
      word-wrap: break-word;
      transition: background 0.1s;
    }

    .log-line:hover {
      background: #2d2d30;
    }

    .log-line.new {
      animation: highlight 0.5s;
    }

    @keyframes highlight {
      0% { background: #264f78; }
      100% { background: transparent; }
    }

    .log-file {
      color: #4ec9b0;
      margin-right: 8px;
    }

    .log-timestamp {
      color: #858585;
      margin-right: 8px;
    }

    .log-level {
      margin-right: 8px;
      padding: 2px 6px;
      border-radius: 2px;
      font-weight: 600;
      font-size: 11px;
    }

    .log-level.ERROR,
    .log-level.FATAL,
    .log-level.CRITICAL {
      background: #f44747;
      color: white;
    }

    .log-level.WARN,
    .log-level.WARNING {
      background: #cca700;
      color: #1e1e1e;
    }

    .log-level.INFO {
      background: #0e639c;
      color: white;
    }

    .log-level.DEBUG,
    .log-level.TRACE {
      background: #858585;
      color: white;
    }

    .log-message {
      color: #d4d4d4;
    }

    .files-panel {
      background: #252526;
      border-right: 1px solid #3e3e42;
      padding: 15px;
      min-width: 250px;
    }

    .files-panel h3 {
      font-size: 12px;
      color: #cccccc;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .file-item {
      padding: 6px 10px;
      margin: 4px 0;
      background: #1e1e1e;
      border-radius: 3px;
      font-size: 12px;
      color: #cccccc;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .file-icon {
      width: 16px;
      height: 16px;
      display: inline-block;
    }

    .stats {
      margin-top: 20px;
      padding: 10px;
      background: #1e1e1e;
      border-radius: 3px;
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      font-size: 11px;
      color: #858585;
    }

    .stat-value {
      color: #4ec9b0;
      font-weight: 600;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #858585;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>LogLens Dashboard</h1>
    <div class="header-info">
      <div class="status">
        <div class="status-dot"></div>
        <span id="connection-status">Connected</span>
      </div>
      <span id="log-count">0 logs</span>
      <span id="file-count">0 files</span>
    </div>
  </div>

  <div class="controls">
    <label>Filter:</label>
    <input type="text" id="filter-input" placeholder="Type to filter logs...">
    <button id="clear-btn" class="secondary">Clear</button>
    <button id="pause-btn" class="secondary">Pause</button>
    <button id="export-btn" class="secondary">Export</button>
  </div>

  <div class="main">
    <div class="log-container" id="log-container">
      <div class="empty-state">Waiting for logs...</div>
    </div>
  </div>

  <script>
    let ws;
    let logs = [];
    let paused = false;
    let autoScroll = true;
    let filterText = '';

    const logContainer = document.getElementById('log-container');
    const filterInput = document.getElementById('filter-input');
    const pauseBtn = document.getElementById('pause-btn');
    const clearBtn = document.getElementById('clear-btn');
    const exportBtn = document.getElementById('export-btn');
    const connectionStatus = document.getElementById('connection-status');
    const logCount = document.getElementById('log-count');
    const fileCount = document.getElementById('file-count');

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);

      ws.onopen = () => {
        connectionStatus.textContent = 'Connected';
        connectionStatus.style.color = '#4ec9b0';
      };

      ws.onclose = () => {
        connectionStatus.textContent = 'Disconnected';
        connectionStatus.style.color = '#f44747';
        setTimeout(connect, 3000);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleMessage(message);
      };
    }

    function handleMessage(message) {
      switch (message.type) {
        case 'init':
          logs = message.logs || [];
          fileCount.textContent = \`\${message.files.length} files\`;
          renderLogs();
          break;
        case 'log':
          if (!paused) {
            logs.push(message.data);
            if (logs.length > 1000) {
              logs.shift();
            }
            addLogLine(message.data);
            updateStats();
          }
          break;
        case 'file_added':
        case 'file_removed':
          // Update file count
          break;
      }
    }

    function renderLogs() {
      logContainer.innerHTML = '';
      const filteredLogs = filterLogs(logs);

      if (filteredLogs.length === 0) {
        logContainer.innerHTML = '<div class="empty-state">No logs to display</div>';
        return;
      }

      filteredLogs.forEach(log => {
        addLogLine(log, false);
      });

      updateStats();
      if (autoScroll) {
        scrollToBottom();
      }
    }

    function addLogLine(log, animate = true) {
      if (filterText && !log.line.toLowerCase().includes(filterText.toLowerCase())) {
        return;
      }

      if (logContainer.querySelector('.empty-state')) {
        logContainer.innerHTML = '';
      }

      const line = document.createElement('div');
      line.className = 'log-line' + (animate ? ' new' : '');

      let html = '';

      if (log.file) {
        html += \`<span class="log-file">[\${log.file}]</span>\`;
      }

      if (log.parsedTimestamp) {
        html += \`<span class="log-timestamp">\${log.parsedTimestamp}</span>\`;
      }

      if (log.level) {
        html += \`<span class="log-level \${log.level}">\${log.level}</span>\`;
      }

      html += \`<span class="log-message">\${escapeHtml(log.line)}</span>\`;

      line.innerHTML = html;
      logContainer.appendChild(line);

      if (autoScroll) {
        scrollToBottom();
      }
    }

    function filterLogs(logs) {
      if (!filterText) return logs;
      return logs.filter(log =>
        log.line.toLowerCase().includes(filterText.toLowerCase())
      );
    }

    function updateStats() {
      logCount.textContent = \`\${logs.length} logs\`;
    }

    function scrollToBottom() {
      logContainer.scrollTop = logContainer.scrollHeight;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Event listeners
    filterInput.addEventListener('input', (e) => {
      filterText = e.target.value;
      renderLogs();
    });

    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      pauseBtn.style.background = paused ? '#f44747' : '#3e3e42';
    });

    clearBtn.addEventListener('click', () => {
      logs = [];
      renderLogs();
    });

    exportBtn.addEventListener('click', () => {
      const text = logs.map(log => log.line).join('\\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`loglens-export-\${Date.now()}.log\`;
      a.click();
      URL.revokeObjectURL(url);
    });

    logContainer.addEventListener('scroll', () => {
      const isScrolledToBottom = logContainer.scrollHeight - logContainer.scrollTop <= logContainer.clientHeight + 50;
      autoScroll = isScrolledToBottom;
    });

    // Connect on load
    connect();
  </script>
</body>
</html>`;
  }
}

export function createDashboard(options: DashboardOptions): Dashboard {
  return new Dashboard(options);
}
