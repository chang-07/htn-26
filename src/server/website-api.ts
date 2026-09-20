import LinqAPIV3 from "@linqapp/sdk";
import { website } from "./website";
import { websiteRequest } from "./website-http";

export async function handleWebsite(request: Request, env: Env) {
  const db = website(env);
  const response = await websiteRequest(request, db, async (phone, code) => {
    if (!env.LINQ_API_KEY) throw new Error("Sign-in delivery is not configured");
    // No dry-run fallback, telemetry body, or console output for authentication codes.
    const linq = new LinqAPIV3({ apiKey: env.LINQ_API_KEY, maxRetries: 0, timeout: 15_000 });
    const from = env.LINQ_FROM_NUMBER || (await linq.phoneNumbers.list()).phone_numbers[0]?.phone_number;
    if (!from) throw new Error("Missing sender");
    await linq.chats.create({ from, to: [phone], message: { parts: [{ type: "text", value: `Your Whim sign-in code is ${code}. It expires in 10 minutes. Don’t share this code with anyone.` }] } });
  });
  if (new URL(request.url).pathname === "/api/account/verify" && response.ok) await db.startBackfill().catch(() => {});
  return response;
}
