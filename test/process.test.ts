import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// Mock child_process.spawn before importing the module under test
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawnWithStreaming } from "../src/process";
import { spawn } from "child_process";

/** Create a fake ChildProcess-like object backed by EventEmitters. */
function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: string | null;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

const baseOpts = {
  bin: "echo",
  args: ["hello"],
  label: "test",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("spawnWithStreaming", () => {
  it("successful exit resolves with stdout", async () => {
    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = spawnWithStreaming(baseOpts);

    child.stdout.emit("data", Buffer.from("hello world"));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toBe("hello world");
  });

  it("non-zero exit rejects", async () => {
    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = spawnWithStreaming(baseOpts);

    child.emit("close", 1);

    await expect(promise).rejects.toThrow("test exited with code 1");
  });

  it("spawn error rejects", async () => {
    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = spawnWithStreaming(baseOpts);

    child.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow("test failed to start: ENOENT");
  });

  it("stdin input is written and closed", async () => {
    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = spawnWithStreaming({ ...baseOpts, input: "my input data" });

    expect(child.stdin.write).toHaveBeenCalledWith("my input data");
    expect(child.stdin.end).toHaveBeenCalled();

    child.emit("close", 0);
    await promise;
  });

  it("stderr streaming produces log lines", async () => {
    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const promise = spawnWithStreaming(baseOpts);

    child.stderr.emit("data", Buffer.from("some warning\n"));
    child.emit("close", 0);

    await promise;

    const messages = stderrSpy.mock.calls.map(c => c[0]);
    expect(messages.some((m: string) => m.includes("some warning"))).toBe(true);

    stderrSpy.mockRestore();
  });

  it("inactivity timeout kills process", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    // Suppress log output
    vi.spyOn(console, "error").mockImplementation(() => {});

    const inactivityTimeout = 5000;
    const promise = spawnWithStreaming({
      ...baseOpts,
      inactivityTimeout,
      catastrophicTimeout: 60000,
    });

    // Advance past inactivity timeout
    vi.advanceTimersByTime(inactivityTimeout + 100);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    // Advance 5 more seconds for SIGKILL escalation (exitCode still null)
    vi.advanceTimersByTime(5000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    // Now close the process to resolve the promise
    child.emit("close", 137);

    await expect(promise).rejects.toThrow("test exited with code 137");
  });

  it("catastrophic timeout kills process", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    vi.spyOn(console, "error").mockImplementation(() => {});

    const catastrophicTimeout = 10000;
    const inactivityTimeout = 3000;
    const promise = spawnWithStreaming({
      ...baseOpts,
      catastrophicTimeout,
      inactivityTimeout,
    });

    // Keep emitting data to prevent inactivity timeout
    const keepAlive = setInterval(() => {
      child.stderr.emit("data", Buffer.from("still working\n"));
    }, inactivityTimeout - 500);

    // Advance to just before catastrophic timeout — inactivity should not fire
    vi.advanceTimersByTime(catastrophicTimeout - 100);
    expect(child.kill).not.toHaveBeenCalled();

    // Advance past catastrophic timeout
    vi.advanceTimersByTime(200);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    // Advance 5 more seconds for SIGKILL escalation
    vi.advanceTimersByTime(5000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    clearInterval(keepAlive);

    // Close process to resolve the promise
    child.emit("close", 137);
    await expect(promise).rejects.toThrow("test exited with code 137");
  });
});
