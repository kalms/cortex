import { handleRequest } from "./server.js";

export class Router {
  route(path: string, body: string): Record<string, unknown> {
    if (path === "/ping") return { ok: true };
    return handleRequest(body);
  }
}
