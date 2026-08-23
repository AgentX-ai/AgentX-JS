/** Minimal ANSI terminal helpers - no external dependencies. */

const IS_TTY = Boolean(process.stdout && process.stdout.isTTY);

function code(value: string): string {
  return IS_TTY ? `\u001b[${value}m` : "";
}

export const RESET = code("0");
export const BOLD = code("1");
const DIM = code("2");
const GREEN = code("32");
const YELLOW = code("33");
const RED = code("31");
const CYAN = code("36");

export const green = (s: string): string => `${GREEN}${s}${RESET}`;
export const yellow = (s: string): string => `${YELLOW}${s}${RESET}`;
export const red = (s: string): string => `${RED}${s}${RESET}`;
export const cyan = (s: string): string => `${CYAN}${s}${RESET}`;
export const bold = (s: string): string => `${BOLD}${s}${RESET}`;
export const dim = (s: string): string => `${DIM}${s}${RESET}`;

const FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

/** Inline spinner that overwrites the current line on a TTY, and is silent otherwise. */
export class Spinner {
  private timer?: NodeJS.Timeout;
  private frame = 0;

  constructor(private message: string) {}

  start(): this {
    if (!IS_TTY) {
      return this;
    }
    this.timer = setInterval(() => {
      process.stdout.write(`\r  ${cyan(FRAMES[this.frame % FRAMES.length])}  ${dim(this.message)}   `);
      this.frame += 1;
    }, 80);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
    return this;
  }

  update(message: string): void {
    this.message = message;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (IS_TTY) {
      process.stdout.write("\r" + " ".repeat(this.message.length + 12) + "\r");
    }
  }

  /** Run `fn` with the spinner visible, stopping it whatever happens. */
  static async run<T>(message: string, fn: (spinner: Spinner) => Promise<T>): Promise<T> {
    const spinner = new Spinner(message).start();
    try {
      return await fn(spinner);
    } finally {
      spinner.stop();
    }
  }
}
