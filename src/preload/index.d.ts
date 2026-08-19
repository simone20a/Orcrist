import type { OrcristApi } from '../shared/protocol.js';

declare global {
  interface Window {
    orcrist: OrcristApi;
    platform: { os: string };
  }
}

export {};
