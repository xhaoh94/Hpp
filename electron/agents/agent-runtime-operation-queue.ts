export type AgentRuntimeOperationKind = "update" | "uninstall" | "session-dispose";

export interface AgentRuntimeOperationState {
  agentId: string;
  kind: AgentRuntimeOperationKind;
}

export class AgentRuntimeOperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private activeOperation: AgentRuntimeOperationState | null = null;

  get active(): AgentRuntimeOperationState | null {
    return this.activeOperation ? { ...this.activeOperation } : null;
  }

  run<T>(
    agentId: string,
    kind: AgentRuntimeOperationKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tail;
    let release = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async () => {
      await previous;
      this.activeOperation = { agentId, kind };
      try {
        return await operation();
      } finally {
        this.activeOperation = null;
        release();
      }
    })();
  }
}

export const agentRuntimeOperationQueue = new AgentRuntimeOperationQueue();
