export type ActivityIdentity = { attemptId: string; harness: string };

export type ActivityEntry = {
  version: 1;
  id: string;
  identity: ActivityIdentity;
  observedAt?: string;
  kind: "message" | "command" | "file-change" | "diagnostic" | "turn" | "raw";
  stream: "stdout" | "stderr";
  text: string;
  toolId?: string;
  outcome?: string;
};

export type ActivityPage = {
  entries: ActivityEntry[];
  cursor?: string;
  reset: boolean;
  errors: string[];
};

export interface ActivityDecoder {
  feed(chunk: Uint8Array, stream: "stdout" | "stderr", observedAt?: string): ActivityEntry[];
  end(): ActivityEntry[];
}

export type ActivityPageOptions = {
  log: string;
  sidecar?: string;
  identity: ActivityIdentity;
  cursor?: string;
  direction: "older" | "newer";
  limit?: number;
};
