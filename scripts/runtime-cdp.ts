import WebSocket from "ws";
import { allocationProbe, type AllocationSnapshot } from "./runtime-metrics.ts";

interface Message {
  id?: number;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
  method?: string;
  params?: unknown;
}
interface Target {
  sessionId: string;
  targetInfo: { type: string; url: string; targetId: string };
  waitingForDebugger: boolean;
}
export class MemoryDebugger {
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private targets = new Map<string, Target>();
  private installs = new Map<string, Promise<void>>();
  readonly errors: string[] = [];
  private constructor(private socket: WebSocket) {
    socket.on("message", (bytes) => {
      const message = JSON.parse(String(bytes)) as Message;
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        message.error
          ? pending.reject(new Error(message.error.message))
          : pending.resolve(message.result);
        return;
      }
      if (message.method === "Target.attachedToTarget") {
        const target = message.params as Target;
        const prior = this.installs.get(target.targetInfo.targetId);
        if (prior) {
          void prior
            .then(() =>
              this.send(
                "Runtime.runIfWaitingForDebugger",
                {},
                target.sessionId,
              ),
            )
            .catch(() => {});
          return;
        }
        this.targets.set(target.sessionId, target);
        this.installs.set(target.targetInfo.targetId, this.install(target));
      }
      if (message.method === "Target.detachedFromTarget")
        this.targets.delete(
          (message.params as { sessionId: string }).sessionId,
        );
    });
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("debugger closed"));
      }
      this.pending.clear();
    });
  }
  static async connect(endpoint: string): Promise<MemoryDebugger> {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const debugger_ = new MemoryDebugger(socket);
    await debugger_.send("Target.setAutoAttach", debugger_.attachment());
    return debugger_;
  }
  send<T = unknown>(
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`debugger timeout: ${method}`));
      }, 10000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  private attachment() {
    return {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page" }, { type: "worker" }, { exclude: true }],
    };
  }
  private async install(target: Target): Promise<void> {
    const session = target.sessionId;
    try {
      await this.send("Runtime.enable", {}, session);
      await this.send("Target.setAutoAttach", this.attachment(), session);
      const expression = `(${allocationProbe})();`;
      if (target.targetInfo.type === "page") {
        await this.send("Page.enable", {}, session);
        await this.send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: expression },
          session,
        );
      }
      const evaluated = await this.send<{ exceptionDetails?: unknown }>(
        "Runtime.evaluate",
        { expression },
        session,
      );
      if (evaluated.exceptionDetails)
        throw new Error(JSON.stringify(evaluated.exceptionDetails));
    } catch (error) {
      if (this.targets.has(session))
        this.errors.push(`${target.targetInfo.type}: ${String(error)}`);
    } finally {
      await this.send("Runtime.runIfWaitingForDebugger", {}, session).catch(
        () => {},
      );
    }
  }
  async snapshot() {
    const targets = [];
    for (const [session, target] of this.targets) {
      try {
        await this.send("HeapProfiler.collectGarbage", {}, session);
        const heap = await this.send<{
          usedSize: number;
          totalSize: number;
          backingStorageSize: number;
        }>("Runtime.getHeapUsage", {}, session);
        const allocation = await this.send<{
          result: { value?: AllocationSnapshot };
          exceptionDetails?: unknown;
        }>(
          "Runtime.evaluate",
          {
            expression: "globalThis.__runtimeAllocationSnapshot?.()",
            returnByValue: true,
          },
          session,
        );
        if (!allocation.result.value)
          throw new Error(
            `memory probe missing: ${target.targetInfo.type} ${target.targetInfo.url}; ${JSON.stringify(allocation)}; setup=${this.errors.join(";")}`,
          );
        targets.push({
          type: target.targetInfo.type,
          url: target.targetInfo.url,
          heap,
          ...allocation.result.value,
        });
      } catch (error) {
        if (this.targets.has(session)) throw error;
      }
    }
    if (this.errors.length) throw new Error(this.errors.join("\n"));
    return {
      targets,
      linearBytes: targets.reduce((n, t) => n + t.linearBytes, 0),
      jsHeapUsedBytes: targets.reduce((n, t) => n + t.heap.usedSize, 0),
    };
  }
  close(): void {
    this.socket.close();
  }
}
