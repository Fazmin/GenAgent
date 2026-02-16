/**
 * Proactive activation mechanism (Heartbeat)
 *
 * Based on:
 * - src/infra/heartbeat-wake.ts — event-driven wake + request coalescing
 * - src/infra/heartbeat-runner.ts — scheduled dispatch + HEARTBEAT.md context passing
 *
 * Core design philosophy:
 * HEARTBEAT.md is not a task list — no checkbox parsing, no structured task management.
 * It is LLM context input: HeartbeatManager reads the content and passes it as-is to
 * the callback (corresponding to getReplyFromConfig), and the LLM decides how to respond.
 *
 * Layers:
 * 1. HeartbeatWake — Request coalescing layer
 *    - Multiple requests within coalesceMs are merged into a single execution
 *    - Double buffering: new requests during a run are queued, executed immediately after
 *    - Automatic retry on requests-in-flight skip (1s delay)
 *
 * 2. HeartbeatManager — Scheduling + policy layer
 *    - setTimeout-based precise scheduling (not setInterval)
 *    - Active time window (activeHours), supports crossing midnight
 *    - HEARTBEAT.md empty content detection (after stripping frontmatter/comments)
 *    - exec events exempt from empty content skip (command completion always passes through)
 *    - Duplicate message suppression (24h window + text comparison)
 */

import fs from "node:fs/promises";
import path from "node:path";

// ============== Type definitions ==============

/**
 * Active time window
 *
 * Based on: isWithinActiveHours() in heartbeat-runner.ts
 * - Controls heartbeat to only run within the specified time range
 * - Supports crossing midnight (e.g. start=22:00, end=06:00)
 */
export interface ActiveHours {
  /** Start time in "HH:MM" format */
  start: string;
  /** End time in "HH:MM" format */
  end: string;
  /** Timezone identifier, defaults to local timezone */
  timezone?: string;
}

export interface HeartbeatConfig {
  /** Check interval (milliseconds), default 30 minutes */
  intervalMs?: number;
  /** HEARTBEAT.md path (relative to workspaceDir or absolute) */
  heartbeatPath?: string;
  /** Active time window */
  activeHours?: ActiveHours;
  /** Whether enabled */
  enabled?: boolean;
  /** Request coalescing window (milliseconds), default 250ms */
  coalesceMs?: number;
  /** Duplicate detection window (milliseconds), default 24 hours */
  duplicateWindowMs?: number;
}

/**
 * Wake reason
 *
 * Based on: multiple trigger sources in heartbeat-runner.ts:
 * - interval: timer expired (scheduleNext)
 * - exec: async command execution completed (EXEC_EVENT_PROMPT, exempt from empty content skip)
 * - requested: external manual request
 * - retry: automatic retry after previous requests-in-flight skip
 */
export type WakeReason =
  | "interval"
  | "exec"
  | "requested"
  | "retry";

export interface WakeRequest {
  reason: WakeReason;
  source?: string;
}

/**
 * Heartbeat run result
 *
 * Based on: HeartbeatRunResult
 * - ran: successfully executed and produced output
 * - skipped: skipped for some reason (active hours / empty content / duplicate)
 * - failed: execution error
 */
export interface HeartbeatResult {
  status: "ran" | "skipped" | "failed";
  durationMs?: number;
  reason?: string;
}

/**
 * Heartbeat callback
 *
 * Corresponds to the role of getReplyFromConfig() in heartbeat-runner.ts:
 * Receives HEARTBEAT.md raw content as context; the caller (typically an LLM)
 * generates reply text.
 *
 * Return values:
 * - { text: "..." }: has content to send (will go through duplicate suppression check)
 * - { text: undefined } or null: equivalent to HEARTBEAT_OK
 *   (LLM determined there is nothing to proactively notify about)
 */
export type HeartbeatCallback = (opts: {
  /** HEARTBEAT.md file content (passed as-is, no parsing) */
  content: string;
  /** Wake reason */
  reason: WakeReason;
  /** Source identifier */
  source?: string;
}) => Promise<{ text?: string } | null>;

/**
 * Heartbeat internal handler
 *
 * Based on: HeartbeatWakeHandler
 * HeartbeatWake layer calls this handler to execute one heartbeat
 */
export type HeartbeatHandler = (opts: {
  reason?: string;
}) => Promise<HeartbeatResult>;

// ============== HeartbeatWake (request coalescing layer) ==============

/**
 * Based on: src/infra/heartbeat-wake.ts
 *
 * Core mechanism:
 * 1. Multiple requests within coalesceMs are merged into a single execution
 * 2. If currently running, new requests are queued (scheduled flag)
 * 3. After run completes, if there are queued requests, continue scheduling
 * 4. Automatic retry on requests-in-flight skip (retryMs)
 *
 * Structure corresponds to heartbeat-wake.ts:
 * - handler / pendingReason / scheduled / running / timer — five global variables
 * - schedule() / setHandler() / requestNow()
 */
class HeartbeatWake {
  private handler: HeartbeatHandler | null = null;
  private pendingReason: string | null = null;
  private scheduled = false;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly coalesceMs: number;
  private readonly retryMs = 1_000;

  constructor(coalesceMs = 250) {
    this.coalesceMs = coalesceMs;
  }

  setHandler(handler: HeartbeatHandler | null): void {
    this.handler = handler;
    if (handler && this.pendingReason) {
      this.schedule(this.coalesceMs);
    }
  }

  /**
   * Request wake
   *
   * Based on: requestHeartbeatNow()
   */
  request(reason: string = "requested", coalesceMs?: number): void {
    this.pendingReason = reason;
    this.schedule(coalesceMs ?? this.coalesceMs);
  }

  private schedule(delayMs: number): void {
    // If timer already exists, don't create another (request coalescing)
    if (this.timer) {
      return;
    }

    this.timer = setTimeout(async () => {
      this.timer = null;
      this.scheduled = false;

      const active = this.handler;
      if (!active) return;

      // If currently running, mark as scheduled and reschedule
      if (this.running) {
        this.scheduled = true;
        this.schedule(this.coalesceMs);
        return;
      }

      const reason = this.pendingReason;
      this.pendingReason = null;
      this.running = true;

      try {
        const res = await active({ reason: reason ?? undefined });

        // Automatic retry on requests-in-flight
        if (res.status === "skipped" && res.reason === "requests-in-flight") {
          this.pendingReason = reason ?? "retry";
          this.schedule(this.retryMs);
        }
      } catch {
        // Retry on error as well
        this.pendingReason = reason ?? "retry";
        this.schedule(this.retryMs);
      } finally {
        this.running = false;
        if (this.pendingReason || this.scheduled) {
          this.schedule(this.coalesceMs);
        }
      }
    }, delayMs);
  }

  hasPending(): boolean {
    return this.pendingReason !== null || Boolean(this.timer) || this.scheduled;
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduled = false;
    this.pendingReason = null;
  }
}

// ============== Helper functions ==============

/**
 * HEARTBEAT.md empty content detection
 *
 * Based on: isHeartbeatContentEffectivelyEmpty() in heartbeat-runner.ts
 * Strips frontmatter and HTML comments, then checks if only whitespace remains
 */
function isContentEffectivelyEmpty(content: string): boolean {
  // Strip YAML frontmatter
  const noFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "");
  // Strip HTML comments
  const noComments = noFrontmatter.replace(/<!--[\s\S]*?-->/g, "");
  return noComments.trim().length === 0;
}

// ============== HeartbeatManager (scheduling + policy layer) ==============

/**
 * Scheduler internal state
 *
 * Based on: HeartbeatAgentState in heartbeat-runner.ts
 */
interface RunnerState {
  /** Next due timestamp (ms) */
  nextDueMs: number;
  /** Scheduling timer */
  timer: ReturnType<typeof setTimeout> | null;
  /** Last run timestamp */
  lastRunMs: number | null;
  /** Last sent text (for duplicate suppression) */
  lastText: string | null;
  /** Last sent text timestamp */
  lastTextAt: number | null;
}

/**
 * Heartbeat Manager - Proactive activation manager
 *
 * Based on: startHeartbeatRunner() in heartbeat-runner.ts:
 * - setTimeout-based precise scheduling (not setInterval)
 * - Active time window check
 * - HEARTBEAT.md empty content detection (not task parsing — key design alignment)
 * - Duplicate message suppression (24h)
 * - exec events exempt from empty content skip
 * - Event-driven wake via HeartbeatWake
 */
export class HeartbeatManager {
  private workspaceDir: string;
  private config: Required<Omit<HeartbeatConfig, "activeHours">> & {
    activeHours?: ActiveHours;
  };

  private state: RunnerState = {
    nextDueMs: 0,
    timer: null,
    lastRunMs: null,
    lastText: null,
    lastTextAt: null,
  };

  private wake: HeartbeatWake;
  private callback: HeartbeatCallback | null = null;
  private started = false;

  constructor(workspaceDir: string, config: HeartbeatConfig = {}) {
    this.workspaceDir = workspaceDir;
    this.config = {
      intervalMs: config.intervalMs ?? 30 * 60 * 1000,
      heartbeatPath: config.heartbeatPath ?? "HEARTBEAT.md",
      enabled: config.enabled ?? true,
      coalesceMs: config.coalesceMs ?? 250,
      duplicateWindowMs: config.duplicateWindowMs ?? 24 * 60 * 60 * 1000,
      activeHours: config.activeHours,
    };

    this.wake = new HeartbeatWake(this.config.coalesceMs);
    // HeartbeatWake handler corresponds to runHeartbeatOnce
    this.wake.setHandler((opts) => this.runOnce(opts.reason));
  }

  // ============== Public API ==============

  /**
   * Register callback
   *
   * Based on: getReplyFromConfig() inside heartbeat-runner:
   * Callback receives HEARTBEAT.md raw content; the caller decides how to respond
   */
  onHeartbeat(callback: HeartbeatCallback): void {
    this.callback = callback;
  }

  /**
   * Start heartbeat scheduling
   *
   * Based on: startHeartbeatRunner()
   */
  start(): void {
    if (!this.config.enabled || this.started) return;
    this.started = true;
    this.scheduleNext();
  }

  /**
   * Stop heartbeat scheduling
   */
  stop(): void {
    this.started = false;
    this.wake.stop();
    if (this.state.timer) {
      clearTimeout(this.state.timer);
      this.state.timer = null;
    }
  }

  /**
   * Request immediate wake (event-driven)
   *
   * Based on: requestHeartbeatNow()
   */
  requestNow(reason: WakeReason = "requested"): void {
    this.wake.request(reason);
  }

  /**
   * Manually trigger once (synchronously waits for result)
   */
  async trigger(): Promise<HeartbeatResult> {
    return this.runOnce("requested");
  }

  /**
   * Read HEARTBEAT.md content
   *
   * Exposed for external use (e.g. agent building system prompt can optionally reference it)
   */
  async readContent(): Promise<string | null> {
    const filePath = this.getHeartbeatPath();
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Update configuration (hot reload)
   */
  updateConfig(config: Partial<HeartbeatConfig>): void {
    if (config.intervalMs !== undefined) {
      this.config.intervalMs = config.intervalMs;
    }
    if (config.activeHours !== undefined) {
      this.config.activeHours = config.activeHours;
    }
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
      if (!config.enabled) {
        this.stop();
      } else if (this.started) {
        this.scheduleNext();
      }
    }

    // Reschedule
    if (this.started && this.config.enabled) {
      if (this.state.timer) {
        clearTimeout(this.state.timer);
      }
      this.scheduleNext();
    }
  }

  /**
   * Get status information (for debugging)
   */
  getStatus(): {
    enabled: boolean;
    started: boolean;
    nextDueMs: number;
    lastRunMs: number | null;
    intervalMs: number;
    activeHours?: ActiveHours;
  } {
    return {
      enabled: this.config.enabled,
      started: this.started,
      nextDueMs: this.state.nextDueMs,
      lastRunMs: this.state.lastRunMs,
      intervalMs: this.config.intervalMs,
      activeHours: this.config.activeHours,
    };
  }

  // ============== Scheduling logic ==============

  /**
   * Schedule next run
   *
   * Based on: scheduleNext() in heartbeat-runner.ts
   * Uses setTimeout for precise scheduling; recalculates delay after each run
   */
  private scheduleNext(): void {
    if (!this.started) return;

    const now = Date.now();
    const lastRun = this.state.lastRunMs ?? now;
    const nextDue = lastRun + this.config.intervalMs;
    this.state.nextDueMs = nextDue;

    const delay = Math.max(0, nextDue - now);

    this.state.timer = setTimeout(() => {
      this.state.timer = null;
      this.wake.request("interval");
    }, delay);
  }

  /**
   * Execute one heartbeat
   *
   * Based on: runHeartbeatOnce() in heartbeat-runner.ts
   * Flow:
   * 1. Active time window check
   * 2. Read HEARTBEAT.md content
   * 3. Empty content detection (exec events exempt)
   * 4. Call callback to get reply (corresponds to getReplyFromConfig)
   * 5. Duplicate message suppression
   * 6. Update state + schedule next
   */
  private async runOnce(reason?: string): Promise<HeartbeatResult> {
    const startMs = Date.now();
    const wakeReason = (reason as WakeReason) || "requested";

    // 1. Active time window check
    if (!this.isWithinActiveHours(startMs)) {
      this.state.lastRunMs = startMs;
      this.scheduleNext();
      return { status: "skipped", reason: "outside-active-hours" };
    }

    // 2. Read HEARTBEAT.md content (as-is, no parsing)
    const content = await this.readContent();

    // 3. Empty content detection — exec events exempt (EXEC_EVENT_PROMPT exception)
    if (
      (!content || isContentEffectivelyEmpty(content)) &&
      wakeReason !== "exec"
    ) {
      this.state.lastRunMs = startMs;
      this.scheduleNext();
      return { status: "skipped", reason: "empty-content" };
    }

    // 4. Call callback to get reply
    if (!this.callback) {
      this.state.lastRunMs = startMs;
      this.scheduleNext();
      return { status: "skipped", reason: "no-callback" };
    }

    try {
      const result = await this.callback({
        content: content ?? "",
        reason: wakeReason,
      });

      const replyText = result?.text?.trim();
      const durationMs = Date.now() - startMs;

      // Empty reply = HEARTBEAT_OK (LLM has nothing to say)
      if (!replyText) {
        this.state.lastRunMs = startMs;
        this.scheduleNext();
        return { status: "ran", durationMs, reason: "ack" };
      }

      // 5. Duplicate message suppression
      if (this.isDuplicateMessage(replyText, startMs)) {
        this.state.lastRunMs = startMs;
        this.scheduleNext();
        return { status: "skipped", durationMs, reason: "duplicate-message" };
      }

      // 6. Update state
      this.state.lastRunMs = startMs;
      this.state.lastText = replyText;
      this.state.lastTextAt = startMs;
      this.scheduleNext();

      return { status: "ran", durationMs };
    } catch {
      this.state.lastRunMs = startMs;
      this.scheduleNext();
      return { status: "failed", reason: "callback-error" };
    }
  }

  // ============== Helper methods ==============

  /**
   * Check whether we are within the active time window
   *
   * Based on: isWithinActiveHours() in heartbeat-runner.ts
   * Supports time ranges crossing midnight (e.g. 22:00-06:00)
   */
  private isWithinActiveHours(nowMs: number): boolean {
    const { activeHours } = this.config;
    if (!activeHours) return true;

    const date = new Date(nowMs);
    const currentMinutes = date.getHours() * 60 + date.getMinutes();

    const [startH, startM] = activeHours.start.split(":").map(Number);
    const [endH, endM] = activeHours.end.split(":").map(Number);

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Crossing midnight: e.g. 22:00-06:00
    if (endMinutes <= startMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  /**
   * Duplicate message suppression
   *
   * Based on: lastHeartbeatText/lastHeartbeatSentAt check in heartbeat-runner.ts:
   * If text is identical within the 24h window, skip to prevent frequent identical notifications
   */
  private isDuplicateMessage(text: string, nowMs: number): boolean {
    if (!this.state.lastText || !this.state.lastTextAt) {
      return false;
    }

    const timeSinceLast = nowMs - this.state.lastTextAt;
    if (timeSinceLast >= this.config.duplicateWindowMs) {
      return false;
    }

    return text.trim() === this.state.lastText.trim();
  }

  private getHeartbeatPath(): string {
    if (path.isAbsolute(this.config.heartbeatPath)) {
      return this.config.heartbeatPath;
    }
    return path.join(this.workspaceDir, this.config.heartbeatPath);
  }
}
