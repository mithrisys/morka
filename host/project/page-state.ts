// This function is serialized into the preview's main world. Keep it self-contained.
export async function pageState(command: "install" | "ready" | "capture" | "restore" | "resume" | "styles", argument?: any): Promise<any> {
  const page = window as any;
  if (!page.__morkaLive) {
    let pending = 0;
    let paused = false;
    let locked = false;
    let resume: (() => void) | undefined;
    let gate = Promise.resolve();
    const fetch = window.fetch;
    window.fetch = async function (...args) {
      if (paused) await gate;
      pending++;
      try {
        const response = await fetch.apply(this, args);
        void response.clone().arrayBuffer().catch(() => {}).finally(() => { pending--; });
        return response;
      } catch (error) { pending--; throw error; }
    };
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      const request = this;
      const run = () => {
        pending++;
        request.addEventListener("loadend", () => { pending--; }, { once: true });
        try { send.call(request, body); } catch (error) { pending--; throw error; }
      };
      if (paused) void gate.then(run);
      else run();
    };
    const key = (element: Element): string => {
      if (element === document.documentElement) return "html";
      if (element.id) return "#" + CSS.escape(element.id);
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement) {
        const tag = current.localName;
        const siblings: Element[] = current.parentElement ? [...current.parentElement.children].filter(item => item.localName === tag) : [];
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
        current = current.parentElement;
      }
      return "html>" + parts.join(">");
    };
    const find = (selector: string) => { try { return document.querySelector(selector) as HTMLElement | null; } catch { return null; } };
    for (const type of ["click", "pointerdown", "keydown", "beforeinput", "submit", "change"]) {
      document.addEventListener(type, event => {
        if (locked && event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
    }
    page.__morkaLive = {
      async capture() {
        if ([...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].some(input => input.files?.length)) {
          throw Error("Finish or cancel the file selection before applying this update.");
        }
        locked = true;
        await page.morkaLifecycle?.beforeUpdate?.();
        await page.morka?.whenIdle?.();
        paused = true;
        gate = new Promise(resolve => { resume = resolve; });
        const deadline = Date.now() + 30_000;
        while (pending) {
          if (!locked) throw Error("The update was cancelled.");
          if (Date.now() > deadline) throw Error("Waiting for the app's current requests to finish. Retry the update when they complete.");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const custom = await page.morkaLifecycle?.capture?.();
        let storage;
        try { storage = { origin: location.origin, local: Object.entries(localStorage), session: Object.entries(sessionStorage) }; } catch {}
        const controls = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")]
          .filter(input => !input.matches('input[type="file"],input[type="hidden"],input[type="submit"],input[type="button"]') &&
            (!input.matches('input[type="checkbox"],input[type="radio"]') || Boolean(input.closest("form"))))
          .map(input => ({ key: key(input), tag: input.localName, type: input.type, name: input.name,
            value: input.value, checked: (input as HTMLInputElement).checked,
            start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd,
            direction: (input as HTMLInputElement).selectionDirection }));
        return { url: location.href, history: history.state, custom, controls, storage,
          focus: document.hasFocus() && document.activeElement ? key(document.activeElement) : undefined,
          scroll: [window.scrollX, window.scrollY],
          scrollers: [...document.querySelectorAll<HTMLElement>("*")].filter(item => item.scrollTop || item.scrollLeft)
            .map(item => ({ key: key(item), x: item.scrollLeft, y: item.scrollTop })),
          details: [...document.querySelectorAll("details")].map(item => ({ key: key(item), open: item.open })) };
      },
      async restore(state: any) {
        if (state.storage && state.storage.origin !== location.origin) {
          for (const [name, entries] of [["localStorage", state.storage.local], ["sessionStorage", state.storage.session]] as const) {
            try { for (const [key, value] of entries) if (page[name].getItem(key) === null) page[name].setItem(key, value); } catch {}
          }
        }
        await page.morkaLifecycle?.ready;
        if (state.history !== null && state.history !== undefined) history.replaceState(state.history, "");
        for (const saved of state.controls) {
          const input = find(saved.key) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
          if (!input || input.localName !== saved.tag || input.type !== saved.type || input.name !== saved.name) continue;
          if (input instanceof HTMLInputElement && ["checkbox", "radio"].includes(input.type)) input.checked = saved.checked;
          else {
            const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
              : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, saved.value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
          try { if (saved.start !== null) (input as HTMLInputElement).setSelectionRange(saved.start, saved.end, saved.direction); } catch {}
        }
        await page.morkaLifecycle?.restore?.(state.custom);
        for (const saved of state.details) {
          const details = find(saved.key);
          if (details instanceof HTMLDetailsElement) details.open = saved.open;
        }
        if (state.focus) find(state.focus)?.focus({ preventScroll: true });
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); requestAnimationFrame(() => { clearTimeout(timer); resolve(); }); });
        window.scrollTo(...state.scroll as [number, number]);
        for (const saved of state.scrollers) find(saved.key)?.scrollTo(saved.x, saved.y);
      },
      resume() { locked = false; paused = false; resume?.(); resume = undefined; },
      async styles(styles: { path: string; url: string }[]) {
        const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];
        const replacements = links.filter(link => {
          const url = new URL(link.href); return url.protocol === location.protocol && url.host === location.host;
        }).map(link => {
          const url = new URL(link.href); url.searchParams.set("morka-update", String(Date.now())); return { link, url: url.href };
        });
        if (!replacements.length) return true;
        await Promise.all(replacements.map(({ link, url }) => new Promise<void>((resolve, reject) => {
          const replacement = link.cloneNode() as HTMLLinkElement;
          replacement.href = url;
          const timer = setTimeout(() => { replacement.remove(); reject(Error("The updated stylesheet could not load.")); }, 10_000);
          replacement.onload = () => { clearTimeout(timer); link.remove(); resolve(); };
          replacement.onerror = () => { clearTimeout(timer); replacement.remove(); reject(Error("The updated stylesheet could not load.")); };
          link.after(replacement);
        })));
        return true;
      },
    };
  }
  const live = page.__morkaLive;
  if (command === "install") return;
  if (command === "ready") { await page.morkaLifecycle?.ready; return; }
  try { return await live[command](argument); }
  catch (error) { live.resume(); throw error; }
}
