import chalk from 'chalk';
import colors from 'ansi-colors';

export interface FilterOptions {
  include?: string[];
  exclude?: string[];
  highlight?: string[];
  caseSensitive?: boolean;
  regex?: boolean;
}

export interface ParsedLogLine {
  timestamp?: string;
  level?: string;
  message: string;
  raw: string;
  file?: string;
}

export class LogFilter {
  private includePatterns: RegExp[] = [];
  private excludePatterns: RegExp[] = [];
  private highlightPatterns: RegExp[] = [];
  private caseSensitive: boolean;

  constructor(options: FilterOptions = {}) {
    this.caseSensitive = options.caseSensitive || false;

    const flags = this.caseSensitive ? 'g' : 'gi';

    if (options.include) {
      this.includePatterns = options.include.map(pattern =>
        new RegExp(options.regex ? pattern : this.escapeRegex(pattern), flags)
      );
    }

    if (options.exclude) {
      this.excludePatterns = options.exclude.map(pattern =>
        new RegExp(options.regex ? pattern : this.escapeRegex(pattern), flags)
      );
    }

    if (options.highlight) {
      this.highlightPatterns = options.highlight.map(pattern =>
        new RegExp(options.regex ? pattern : this.escapeRegex(pattern), flags)
      );
    }
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  shouldInclude(line: string): boolean {
    // If no include patterns, include everything
    if (this.includePatterns.length === 0) {
      // Check exclude patterns
      if (this.excludePatterns.length > 0) {
        return !this.excludePatterns.some(pattern => pattern.test(line));
      }
      return true;
    }

    // Must match at least one include pattern
    const included = this.includePatterns.some(pattern => pattern.test(line));
    if (!included) return false;

    // Must not match any exclude patterns
    if (this.excludePatterns.length > 0) {
      return !this.excludePatterns.some(pattern => pattern.test(line));
    }

    return true;
  }

  applyHighlighting(line: string): string {
    let highlighted = line;

    for (const pattern of this.highlightPatterns) {
      highlighted = highlighted.replace(pattern, match => chalk.yellow.bold(match));
    }

    return highlighted;
  }

  parseLogLine(line: string, filename?: string): ParsedLogLine {
    const parsed: ParsedLogLine = {
      raw: line,
      message: line,
      file: filename
    };

    // Try to extract timestamp (common formats)
    const timestampPatterns = [
      /^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
      /^\[(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]/,
      /^(\d{2}\/\w+\/\d{4}:\d{2}:\d{2}:\d{2}\s[+-]\d{4})/,
    ];

    for (const pattern of timestampPatterns) {
      const match = line.match(pattern);
      if (match) {
        parsed.timestamp = match[1];
        break;
      }
    }

    // Try to extract log level
    const levelPattern = /\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|TRACE|CRITICAL)\b/i;
    const levelMatch = line.match(levelPattern);
    if (levelMatch) {
      parsed.level = levelMatch[1].toUpperCase();
    }

    return parsed;
  }

  formatLine(parsed: ParsedLogLine, showFile: boolean = false): string {
    let formatted = '';

    // Add filename prefix if multiple files
    if (showFile && parsed.file) {
      formatted += chalk.cyan(`[${parsed.file}] `);
    }

    // Add timestamp
    if (parsed.timestamp) {
      formatted += chalk.gray(parsed.timestamp) + ' ';
    }

    // Colorize based on log level
    let message = parsed.message;
    if (parsed.level) {
      message = this.colorizeByLevel(message, parsed.level);
    }

    // Apply highlighting
    message = this.applyHighlighting(message);

    formatted += message;

    return formatted;
  }

  private colorizeByLevel(line: string, level: string): string {
    switch (level) {
      case 'ERROR':
      case 'FATAL':
      case 'CRITICAL':
        return chalk.red(line);
      case 'WARN':
      case 'WARNING':
        return chalk.yellow(line);
      case 'INFO':
        return chalk.blue(line);
      case 'DEBUG':
      case 'TRACE':
        return chalk.gray(line);
      default:
        return line;
    }
  }
}

export function createDefaultFilter(options: FilterOptions = {}): LogFilter {
  return new LogFilter(options);
}

// Utility function to detect log format
export function detectLogFormat(lines: string[]): string {
  const formats: { [key: string]: number } = {
    json: 0,
    apache: 0,
    nginx: 0,
    syslog: 0,
    generic: 0
  };

  for (const line of lines.slice(0, 10)) {
    try {
      JSON.parse(line);
      formats.json++;
    } catch {}

    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(line)) {
      formats.apache++;
    }

    if (/^\d{4}\/\d{2}\/\d{2}\s\d{2}:\d{2}:\d{2}/.test(line)) {
      formats.nginx++;
    }

    if (/^[A-Z][a-z]{2}\s+\d+\s\d{2}:\d{2}:\d{2}/.test(line)) {
      formats.syslog++;
    }

    formats.generic++;
  }

  return Object.keys(formats).reduce((a, b) =>
    formats[a] > formats[b] ? a : b
  );
}
