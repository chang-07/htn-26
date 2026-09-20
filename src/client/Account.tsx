import parsePhoneNumber, { getCountries, getCountryCallingCode, type CountryCode } from "libphonenumber-js/min";
import { useEffect, useState, type FormEvent } from "react";
import { Dashboard } from "./Dashboard";
import { readDashboard } from "./dashboard-state";
import type { DashboardState } from "../shared/workspace";
import "./Account.css";
import { api, ApiError, type Account } from "./account-api";
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const countries = getCountries().map(country => ({ country, name: countryNames.of(country) || country, dial: getCountryCallingCode(country) })).sort((a, b) => a.name.localeCompare(b.name));
function SignIn({ onSignedIn }: { onSignedIn: (welcome?: "sent" | "failed") => void }) {
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState<CountryCode>("CA");
  const [sentTo, setSentTo] = useState("");
  function changePhone(value: string) {
    if (value.trim().startsWith("+")) {
      const parsed = parsePhoneNumber(value, { extract: false });
      const match = parsed?.country || countries.find(entry => entry.dial === parsed?.countryCallingCode)?.country;
      if (parsed && match) { setCountry(match); setPhone(parsed.nationalNumber); return; }
    }
    setPhone(value);
  }
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      if (!challenge) {
        const parsed = parsePhoneNumber(phone, { defaultCountry: country, extract: false });
        if (!parsed?.isPossible() || parsed.ext) throw new Error("Enter a valid phone number for the selected country.");
        const result = await api<{ id: string }>("/api/account/code", { method: "POST", body: JSON.stringify({ phone: parsed.number }) });
        setSentTo(parsed.formatInternational()); setChallenge(result.id);
      }
      else { const result = await api<{ welcome?: "sent" | "failed" }>("/api/account/verify", { method: "POST", body: JSON.stringify({ id: challenge, code }) }); onSignedIn(result.welcome); }
    } catch (error) { setError(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <div className="account-page"><a className="account-wordmark" href="/">whim<span>✳</span></a><main className="account-panel"><h1>{challenge ? "Check your messages." : "Your group’s plans,\nall here."}</h1><p>{challenge ? `We sent a six-digit code to ${sentTo}.` : "Sign in with the number you use to message Whim."}</p><form onSubmit={submit}>
    {challenge ? <label key="code">Sign-in code<input autoFocus autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} required placeholder="000000" /></label> : <div key="phone" className="account-phone-row"><label>Country code<select aria-label="Country code" autoComplete="country" value={country} disabled={busy} onChange={e => setCountry(e.target.value as CountryCode)}>{countries.map(entry => <option key={entry.country} value={entry.country}>{entry.country} +{entry.dial} · {entry.name}</option>)}</select></label><label>Phone number<input autoFocus type="tel" autoComplete="tel-national" value={phone} disabled={busy} onChange={e => changePhone(e.target.value)} required maxLength={32} placeholder={getCountryCallingCode(country) === "1" ? "416 555 0123" : "Phone number"} /></label></div>}
    {error && <p className="account-error" role="alert">{error}</p>}<button className="account-primary" disabled={busy}>{busy ? "One moment…" : challenge ? "Sign in" : "Send iMessage code"}</button>
    {challenge && <button type="button" className="account-secondary" disabled={busy} onClick={() => { setChallenge(""); setCode(""); setError(""); }}>Use another number or request a new code</button>}
  </form><p className="account-footnote">{challenge ? "Your code expires in 10 minutes." : "New here? Verify your number to create your account. Whim will text you to get started."}</p></main></div>;
}
export function AccountDashboard() {
  const [loaded, setLoaded] = useState<{ account: Account; data: DashboardState; revision: number } | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [welcome, setWelcome] = useState<"sent" | "failed">();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(""); setSignedOut(false);
    (async () => {
      const { account } = await api<{ account: Account }>("/api/account/session");
      const workspace = await api<{ data: unknown; revision: number }>("/api/account/workspace");
      if (active) setLoaded({ account, data: readDashboard(workspace.data ? JSON.stringify(workspace.data) : null), revision: workspace.revision });
    })().catch(e => { if (!active) return; if (e instanceof ApiError && e.status === 401) setSignedOut(true); else setError(e.message); });
    return () => { active = false; };
  }, [attempt]);
  if (signedOut) return <SignIn onSignedIn={status => { setWelcome(status); setAttempt(n => n + 1); }} />;
  if (!loaded) return <div className="account-page"><a className="account-wordmark" href="/">whim<span>✳</span></a><main className="account-panel"><p role="status">{error || "Loading your workspace…"}</p>{error && <button className="account-primary" onClick={() => setAttempt(n => n + 1)}>Try again</button>}</main></div>;
  return <Dashboard key={loaded.account.id} initialData={loaded.data} initialRevision={loaded.revision} initialNotice={welcome === "sent" ? "Whim sent you a welcome message. Reply to it to get started." : welcome === "failed" ? "You’re signed in, but Whim couldn’t send your welcome message. Reply to your sign-in text to start chatting." : ""} account={loaded.account} onSignOut={() => { setLoaded(null); setSignedOut(true); }} />;
}
