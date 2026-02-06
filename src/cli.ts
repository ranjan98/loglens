#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { LogTailer } from './tail';
import { LogWatcher } from './watcher';
import { createDashboard } from './dashboard';
import { LogFilter, FilterOptions } from './filters';

const program = new Command();

program
  .name('loglens')
  .description('A powerful log file monitoring tool with real-time tailing, pattern matching, and web dashboard')
  .version('1.0.0');

// Tail command
program
  .command('tail')
  .description('Tail one or more log files')
  .argument('<files...>', 'Log files to tail')
  .option('-n, --lines <number>', 'Number of lines to display', '10')
  .option('-f, --follow', 'Follow log file updates', false)
  .option('--include <patterns...>', 'Only show lines matching these patterns')
  .option('--exclude <patterns...>', 'Exclude lines matching these patterns')
  .option('--highlight <patterns...>', 'Highlight text matching these patterns')
  .option('-i, --ignore-case', 'Case insensitive pattern matching', false)
  .option('--regex', 'Treat patterns as regular expressions', false)
  .action(async (files: string[], options) => {
    try {
      const tailer = new LogTailer();
      const absoluteFiles = files.map(f => path.resolve(f));

      // Validate files
      for (const file of absoluteFiles) {
        if (!fs.existsSync(file)) {
          console.error(chalk.red(`Error: File not found: ${file}`));
          process.exit(1);
        }
      }

      // Setup filter
      const filterOptions: FilterOptions = {
        include: options.include,
        exclude: options.exclude,
        highlight: options.highlight,
        caseSensitive: !options.ignoreCase,
        regex: options.regex
      };

      const filter = new LogFilter(filterOptions);

      // Handle lines
      tailer.on('line', (event) => {
        if (!filter.shouldInclude(event.line)) {
          return;
        }

        const parsed = filter.parseLogLine(event.line, path.basename(event.file));
        const formatted = filter.formatLine(parsed, absoluteFiles.length > 1);
        console.log(formatted);
      });

      tailer.on('error', (error) => {
        console.error(chalk.red('Error:'), error.message);
      });

      tailer.on('fileRemoved', (file) => {
        console.error(chalk.yellow(`Warning: File removed: ${file}`));
      });

      // Start tailing
      const numLines = parseInt(options.lines, 10);
      await tailer.tailMultiple(absoluteFiles, {
        lines: numLines,
        follow: options.follow
      });

      if (options.follow) {
        console.error(chalk.gray(`Following ${absoluteFiles.length} file(s)... (Ctrl+C to stop)`));
      }

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.log(chalk.gray('\nStopping...'));
        tailer.close();
        process.exit(0);
      });

    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

// Watch command
program
  .command('watch')
  .description('Watch log files for changes and new files')
  .argument('<files...>', 'Log files or patterns to watch')
  .option('--include <patterns...>', 'Only show lines matching these patterns')
  .option('--exclude <patterns...>', 'Exclude lines matching these patterns')
  .option('--highlight <patterns...>', 'Highlight text matching these patterns')
  .option('-i, --ignore-case', 'Case insensitive pattern matching', false)
  .option('--regex', 'Treat patterns as regular expressions', false)
  .action((files: string[], options) => {
    try {
      const absoluteFiles = files.map(f => path.resolve(f));

      // Setup filter
      const filterOptions: FilterOptions = {
        include: options.include,
        exclude: options.exclude,
        highlight: options.highlight,
        caseSensitive: !options.ignoreCase,
        regex: options.regex
      };

      const filter = new LogFilter(filterOptions);

      // Create watcher
      const watcher = new LogWatcher(absoluteFiles);

      watcher.on('line', (data) => {
        if (!filter.shouldInclude(data.line)) {
          return;
        }

        const parsed = filter.parseLogLine(data.line, path.basename(data.file));
        const formatted = filter.formatLine(parsed, absoluteFiles.length > 1);
        console.log(formatted);
      });

      watcher.on('fileAdded', (change) => {
        console.error(chalk.green(`File added: ${change.file}`));
      });

      watcher.on('fileRemoved', (change) => {
        console.error(chalk.yellow(`File removed: ${change.file}`));
      });

      watcher.on('error', (error) => {
        console.error(chalk.red('Error:'), error.message);
      });

      watcher.on('ready', () => {
        console.error(chalk.gray(`Watching ${absoluteFiles.length} file(s)... (Ctrl+C to stop)`));
      });

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.log(chalk.gray('\nStopping...'));
        watcher.close();
        process.exit(0);
      });

    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

// Dashboard command
program
  .command('dashboard')
  .description('Start web dashboard with live log updates')
  .argument('<files...>', 'Log files to monitor')
  .option('-p, --port <number>', 'Port to run dashboard on', '3000')
  .option('-H, --host <host>', 'Host to bind to', 'localhost')
  .option('--include <patterns...>', 'Only show lines matching these patterns')
  .option('--exclude <patterns...>', 'Exclude lines matching these patterns')
  .option('--highlight <patterns...>', 'Highlight text matching these patterns')
  .option('-i, --ignore-case', 'Case insensitive pattern matching', false)
  .option('--regex', 'Treat patterns as regular expressions', false)
  .action(async (files: string[], options) => {
    try {
      const absoluteFiles = files.map(f => path.resolve(f));

      // Validate files
      for (const file of absoluteFiles) {
        if (!fs.existsSync(file)) {
          console.error(chalk.red(`Error: File not found: ${file}`));
          process.exit(1);
        }
      }

      // Setup filter options
      const filterOptions: FilterOptions = {
        include: options.include,
        exclude: options.exclude,
        highlight: options.highlight,
        caseSensitive: !options.ignoreCase,
        regex: options.regex
      };

      const dashboard = createDashboard({
        port: parseInt(options.port, 10),
        host: options.host,
        files: absoluteFiles,
        filterOptions
      });

      await dashboard.start();

      console.log(chalk.green('Dashboard started successfully!'));
      console.log(chalk.cyan(`\nOpen your browser to: http://${options.host}:${options.port}`));
      console.log(chalk.gray(`\nMonitoring ${absoluteFiles.length} file(s):`));
      absoluteFiles.forEach(file => {
        console.log(chalk.gray(`  - ${file}`));
      });
      console.log(chalk.gray('\nPress Ctrl+C to stop'));

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.log(chalk.gray('\nStopping dashboard...'));
        dashboard.stop();
        process.exit(0);
      });

    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

// Parse arguments
program.parse();
