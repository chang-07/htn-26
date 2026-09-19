import { getAgentByName } from "agents";
import type { PlanAgent } from "./agent";

/**
 * A workflow's line back to its chat's agent, that survives a deploy.
 *
 * AgentWorkflow makes one stub when the workflow starts and keeps it. A deploy
 * restarts every Durable Object, which leaves that stub dead for good ("this
 * Durable Object instance is no longer active"): every retry of a report step
 * then fails on the same dead stub, and work that finished fine never reaches
 * the chat. It happened in production, to a search that had taken 31 seconds.
 *
 * So nothing is kept: each call looks the agent up again by name. The name is
 * asked for once, from the stub the SDK made, while it is certainly alive.
 */
export function liveAgent(env: Env, first: DurableObjectStub<PlanAgent>): DurableObjectStub<PlanAgent> {
  let name: Promise<string> | undefined;
  return new Proxy({} as DurableObjectStub<PlanAgent>, {
    get: (_target, method) => {
      if (typeof method !== "string" || method === "then") return undefined; // not a thenable
      return async (...args: unknown[]) => {
        name ??= Promise.resolve(first.chatId());
        const chat = await name.catch((err: unknown) => {
          name = undefined;
          throw err;
        });
        const stub = await getAgentByName<Env, PlanAgent>(env.PlanAgent, chat);
        return (stub as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
      };
    },
  });
}
