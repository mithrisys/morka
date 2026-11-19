(() => {
  let nextId = 0;
  const pending = new Map<number, (result: AddonResult) => void>();
  const idle = new Set<() => void>();

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== "morka:addon-result") return;
    const { id, result } = event.data;
    const finish = pending.get(id);
    if (!finish) return;
    pending.delete(id);
    finish(result);
    if (!pending.size) { for (const resolve of idle) resolve(); idle.clear(); }
  });

  function invoke(request: AddonRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (result) => result.error ? reject(new Error(result.error)) : resolve(result.value));
      try {
        window.parent.postMessage({ type: "morka:addon-request", id, request }, "*");
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  const api = Object.freeze({
    whenIdle: () => pending.size ? new Promise<void>(resolve => idle.add(resolve)) : Promise.resolve(),
    runAgentAction(action: string, input: unknown): Promise<unknown> {
      return invoke({ type: "runAgentAction", action, input });
    },
  });
  Object.defineProperty(window, "morka", { value: api });
})();
