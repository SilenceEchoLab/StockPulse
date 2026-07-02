import fs from 'fs';
import path from 'path';

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m"
};

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (e) {
  console.error("Failed to create log directory:", e);
}

function stripAnsi(str: string) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function writeToFile(str: string) {
  try {
    fs.appendFileSync(LOG_FILE, stripAnsi(str) + '\n');
  } catch (e) {
    // Ignore file write errors to avoid crashing the app
  }
}

function out(msg: string, ...args: any[]) {
  console.log(msg, ...args.length ? args : '');
  let fullMsg = msg;
  if (args.length) fullMsg += ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  writeToFile(fullMsg);
}

function err(msg: string, ...args: any[]) {
  console.error(msg, ...args.length ? args : '');
  let fullMsg = msg;
  if (args.length) fullMsg += ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  writeToFile(fullMsg);
}

function formatTime() {
  const d = new Date();
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export const logger = {
  info: (tag: string, msg: string, ...args: any[]) => {
    out(`${colors.gray}[${formatTime()}]${colors.reset} ${colors.cyan}[${tag}]${colors.reset} ${msg}`, ...args);
  },
  success: (tag: string, msg: string, ...args: any[]) => {
    out(`${colors.gray}[${formatTime()}]${colors.reset} ${colors.green}[${tag}]${colors.reset} ${msg}`, ...args);
  },
  warn: (tag: string, msg: string, ...args: any[]) => {
    out(`${colors.gray}[${formatTime()}]${colors.reset} ${colors.yellow}[${tag}]${colors.reset} ${msg}`, ...args);
  },
  error: (tag: string, msg: string, ...args: any[]) => {
    err(`${colors.gray}[${formatTime()}]${colors.reset} ${colors.red}[${tag}]${colors.reset} ${msg}`, ...args);
  },

  llm: {
    request: (actionName: string, model: string, details?: any) => {
      out(`\n${colors.magenta}╭─── 🤖 LLM REQUEST [${actionName}] ───${colors.reset}`);
      out(`${colors.magenta}│${colors.reset} ${colors.dim}Time:${colors.reset} ${formatTime()}`);
      out(`${colors.magenta}│${colors.reset} ${colors.dim}Model:${colors.reset} ${colors.bright}${model}${colors.reset}`);
      if (details !== undefined) {
         try {
             const str = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
             const lines = str.split('\n');
             if (lines.length > 50) {
                 out(`${colors.magenta}│${colors.reset} ${colors.dim}Payload:${colors.reset} (Truncated, total ${lines.length} lines)`);
                 lines.slice(0, 20).forEach(l => out(`${colors.magenta}│${colors.reset}   ${colors.gray}${l}${colors.reset}`));
                 out(`${colors.magenta}│${colors.reset}   ${colors.gray}...${colors.reset}`);
                 lines.slice(-5).forEach(l => out(`${colors.magenta}│${colors.reset}   ${colors.gray}${l}${colors.reset}`));
             } else {
                 out(`${colors.magenta}│${colors.reset} ${colors.dim}Payload:${colors.reset}`);
                 lines.forEach(l => out(`${colors.magenta}│${colors.reset}   ${colors.gray}${l}${colors.reset}`));
             }
         } catch {
             out(`${colors.magenta}│${colors.reset} ${colors.dim}Payload:${colors.reset} [Object]`);
         }
      }
      out(`${colors.magenta}╰──────────────────────────────────────${colors.reset}\n`);
    },
    
    response: (actionName: string, latencyMs: number, result: any) => {
      out(`\n${colors.green}╭─── ✨ LLM RESPONSE [${actionName}] ───${colors.reset}`);
      out(`${colors.green}│${colors.reset} ${colors.dim}Time:${colors.reset} ${formatTime()} ${colors.dim}(Latency: ${latencyMs}ms)${colors.reset}`);
      if (result !== undefined) {
          try {
             const str = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
             const lines = str.split('\n');
             if (lines.length > 50) {
                 out(`${colors.green}│${colors.reset} ${colors.dim}Result:${colors.reset} (Truncated, total ${lines.length} lines)`);
                 lines.slice(0, 30).forEach(l => out(`${colors.green}│${colors.reset}   ${colors.cyan}${l}${colors.reset}`));
                 out(`${colors.green}│${colors.reset}   ${colors.gray}...${colors.reset}`);
                 lines.slice(-5).forEach(l => out(`${colors.green}│${colors.reset}   ${colors.cyan}${l}${colors.reset}`));
             } else {
                 out(`${colors.green}│${colors.reset} ${colors.dim}Result:${colors.reset}`);
                 lines.forEach(l => out(`${colors.green}│${colors.reset}   ${colors.cyan}${l}${colors.reset}`));
             }
          } catch {
             out(`${colors.green}│${colors.reset} ${colors.dim}Result:${colors.reset} [Object]`);
          }
      }
      out(`${colors.green}╰───────────────────────────────────────${colors.reset}\n`);
    },
    
    error: (actionName: string, error: any) => {
      out(`\n${colors.red}╭─── ❌ LLM ERROR [${actionName}] ───${colors.reset}`);
      out(`${colors.red}│${colors.reset} ${colors.dim}Time:${colors.reset} ${formatTime()}`);
      out(`${colors.red}│${colors.reset} ${colors.dim}Error:${colors.reset} ${error?.message || error}`);
      out(`${colors.red}╰────────────────────────────────────${colors.reset}\n`);
    }
  }
};
