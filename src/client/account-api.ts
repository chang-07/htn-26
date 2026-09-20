export type Account = { id: string; phone: string };
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { "content-type": "application/json", ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Couldn’t connect. Please try again.";
    throw new ApiError(message, response.status);
  }
  return data as T;
}
