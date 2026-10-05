import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CoordinationStore, stableDigest, validateId, type CoordinationEvent } from "./coordination-state.js";
import type { MutationIdentity } from "./coordination.js";
import { atomic, clean, git, json, locked, repository } from "./system.js";

export interface OperationJournal<T> {
  input: unknown; createdAt: string; expectedHead: string; data: T; pendingEvent?: CoordinationEvent; completed?: boolean;
}
/** Reserve exact mutation inputs and persist each pending event before its Git commit. */
export function coordinationOperation<T, R>(options: {
  store: CoordinationStore; input: MutationIdentity; action: string;
  initialize: () => T; execute: (context: {
    journal: OperationJournal<T>; save: () => void;
    write: (options: { id: string; operationId: string; payload: object }) => ReturnType<CoordinationStore["writeRecord"]>;
  }) => R;
}): R {
  const { store, input } = options, runtime = repository(store.root).stateDir;
  validateId({ value: input.id }); validateId({ value: input.operationId });
  const path = resolve(runtime, options.action, `${input.operationId}.json`), digest = (value: unknown) => stableDigest({ value: JSON.parse(JSON.stringify(value)) });
  return locked(runtime, () => {
    let journal = existsSync(path) ? json<OperationJournal<T>>(path) : undefined;
    if (journal && digest(journal.input) !== digest(input)) throw new Error("Immutable operation identity differs");
    if (git(store.root, "branch", "--show-current") !== store.readManifest().coordinationBranch) throw new Error("Mutation requires declared coordination branch");
    if (!journal) {
      if (store.readSnapshot().head !== input.expectedHead || !clean(store.root)) throw new Error("Mutation requires expected head and clean Store checkout");
      journal = { input: structuredClone(input), createdAt: input.createdAt ?? new Date().toISOString(), expectedHead: input.expectedHead, data: options.initialize() };
      atomic(path, journal);
    }
    const tx = journal, save = () => atomic(path, tx);
    if (tx.pendingEvent) { const result = store.writeRecord({ record: tx.pendingEvent, expectedHead: tx.expectedHead }); tx.expectedHead = result.head; delete tx.pendingEvent; save(); }
    if (tx.completed) tx.expectedHead = store.readSnapshot().head;
    if (store.readSnapshot().head !== tx.expectedHead) throw new Error("Coordination head changed since durable intent; reconcile history");
    const write = (entry: { id: string; operationId: string; payload: object }) => {
      const previous = store.readRecord({ kind: "event", id: entry.id });
      const record = { version: 1, kind: "event", featureId: store.featureId, createdAt: tx.createdAt,
        sequence: previous?.kind === "event" ? previous.sequence : Math.max(0, ...store.readSnapshot().records.filter((r): r is CoordinationEvent => r.kind === "event").map(r => r.sequence)) + 1, ...entry.payload,
        id: entry.id, operationId: entry.operationId } as CoordinationEvent;
      if (previous) {
        if (digest(previous) !== digest(record)) throw new Error("Immutable operation event identity differs");
        return { path: `${store.directory}/events/${entry.id}.json`, created: false, head: tx.expectedHead, operationId: entry.operationId };
      }
      tx.pendingEvent = record; save();
      const result = store.writeRecord({ record, expectedHead: tx.expectedHead }); tx.expectedHead = result.head; delete tx.pendingEvent; save(); return result;
    };
    const result = options.execute({ journal: tx, save, write });
    tx.completed = true; save(); return result;
  });
}
