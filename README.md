# LogLens

Tail multiple log files simultaneously with smart filtering and a web dashboard.

## Features

- Multi-file tailing
- Real-time filtering with regex
- Color-coded log levels
- Web dashboard with live updates
- Pattern highlighting
- Fast and lightweight

## Installation

```bash
npm install -g loglens
```

## Usage

```bash
# Tail multiple files
loglens tail app.log nginx.log db.log

# Filter for errors
loglens tail *.log --filter "ERROR|WARN"

# Start web dashboard
loglens dashboard --port 3000
```

## License

MIT
