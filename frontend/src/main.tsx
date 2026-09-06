// @ts-nocheck
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CognitoIdentityClient } from "@aws-sdk/client-cognito-identity";
import { CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand } from "@aws-sdk/client-cognito-identity-provider";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { clearSession, readSession, SessionExpiredError, tokenExpiresSoon, writeSession } from "./auth";
import "./style.css";

const api = import.meta.env.VITE_API_URL;
const region = import.meta.env.VITE_AWS_REGION || "us-east-1";
const pool = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
const identityPool = import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID;
const identityProvider = `cognito-idp.${region}.amazonaws.com/${pool}`;
const cognitoClient = new CognitoIdentityProviderClient({ region });
let credentialsProvider: any;

const state = (quota: any) => quota.status === "ERROR" || quota.utilizationPercent >= 95 ? "critical" : quota.status === "WARN" || quota.utilizationPercent >= 80 ? "warning" : "healthy";

async function currentSession() {
  const session = readSession();
  if (!session) throw new SessionExpiredError();
  if (!tokenExpiresSoon(session.idToken)) return session;
  try {
    const result = await cognitoClient.send(new InitiateAuthCommand({ AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: clientId, AuthParameters: { REFRESH_TOKEN: session.refreshToken } }));
    const idToken = result.AuthenticationResult?.IdToken;
    if (!idToken) throw new SessionExpiredError();
    const refreshed = { idToken, refreshToken: result.AuthenticationResult?.RefreshToken || session.refreshToken };
    writeSession(refreshed);
    credentialsProvider = undefined;
    return refreshed;
  } catch {
    clearSession();
    credentialsProvider = undefined;
    throw new SessionExpiredError();
  }
}

async function signed(path: string) {
  const session = await currentSession();
  credentialsProvider ??= fromCognitoIdentityPool({ client: new CognitoIdentityClient({ region }) as any, identityPoolId: identityPool, logins: { [identityProvider]: session.idToken } });
  const url = new URL(`${api}${path}`);
  const request = new HttpRequest({ method: "GET", protocol: url.protocol, hostname: url.hostname, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), headers: { host: url.hostname } });
  const signedRequest = await new SignatureV4({ credentials: credentialsProvider, region, service: "lambda", sha256: Sha256 }).sign(request);
  const headers = { ...signedRequest.headers };
  delete headers.host;
  return fetch(url, { headers });
}

function App() {
  const [items, setItems] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [challenge, setChallenge] = useState<any>();
  const [session, setSession] = useState(readSession());

  const complete = (result: { IdToken?: string; RefreshToken?: string }) => {
    if (!result.IdToken || !result.RefreshToken) throw new SessionExpiredError("Sign-in did not return a complete session.");
    const nextSession = { idToken: result.IdToken, refreshToken: result.RefreshToken };
    writeSession(nextSession);
    credentialsProvider = undefined;
    setSession(nextSession);
    setChallenge(undefined);
    setPassword("");
    setNextPassword("");
  };

  const signOut = () => {
    clearSession();
    credentialsProvider = undefined;
    setSession(null);
  };

  const login = async (event: any) => {
    event.preventDefault();
    setError("");
    try {
      const result = challenge
        ? await cognitoClient.send(new RespondToAuthChallengeCommand({ ClientId: clientId, ChallengeName: challenge.name, Session: challenge.session, ChallengeResponses: { USERNAME: email, NEW_PASSWORD: nextPassword } }))
        : await cognitoClient.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: clientId, AuthParameters: { USERNAME: email, PASSWORD: password } }));
      if (result.AuthenticationResult?.IdToken) complete(result.AuthenticationResult);
      else if (result.ChallengeName && result.Session) {
        setChallenge({ name: result.ChallengeName, session: result.Session });
        setError("Your temporary password must be changed.");
      } else throw new Error("Sign-in did not return an ID token");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed");
    }
  };

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const [summaryResponse, quotasResponse] = await Promise.all([signed("/summary"), signed("/quotas?limit=500")]);
      if (!summaryResponse.ok || !quotasResponse.ok) {
        const status = !summaryResponse.ok ? summaryResponse.status : quotasResponse.status;
        throw Object.assign(Error(status === 401 || status === 403 ? "You are not authorized to view quota data" : `Dashboard data request failed (${status}).`), { status });
      }
      setSummary((await summaryResponse.json()).items?.[0] || {});
      setItems((await quotasResponse.json()).items || []);
    } catch (reason) {
      credentialsProvider = undefined;
      const status = Number((reason as any)?.status || 0);
      if (reason instanceof SessionExpiredError || status === 401 || status === 403) {
        signOut();
        setError("Your sign-in session expired or you are not authorized to view quota data. Please sign in again.");
      } else setError(`${reason instanceof Error ? reason.message : "Could not refresh dashboard data."} Use Refresh data to retry.`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { if (session) refresh(); }, [session]);

  if (!session) return <main className="login"><form onSubmit={login} className="panel"><p className="eyebrow">QUOTA MONITOR</p><h1>{challenge ? "Set a new password" : "Sign in"}</h1>{error && <div className="alert" role="alert">{error}</div>}{!challenge && <label>Email<input required type="email" value={email} onChange={event => setEmail(event.target.value)} /></label>}{challenge ? <label>New password<input required minLength={14} type="password" value={nextPassword} onChange={event => setNextPassword(event.target.value)} /></label> : <label>Password<input required type="password" value={password} onChange={event => setPassword(event.target.value)} /></label>}<button>{challenge ? "Set password" : "Sign in"}</button></form></main>;
  const visible = items.filter(quota => `${quota.serviceCode} ${quota.quotaName} ${quota.accountId} ${quota.region}`.toLowerCase().includes(filter.toLowerCase()));
  return <main><header><div><p className="eyebrow">QUOTA MONITOR</p><h1>Organization quota health</h1></div><button onClick={refresh} disabled={busy}>{busy ? "Refreshing…" : "Refresh data"}</button></header>{error && <div className="alert" role="alert">{error}</div>}<section className="cards">{[["Total quotas", summary.totalQuotas || 0, ""], ["Healthy", summary.healthy || 0, "healthy"], ["Warning", summary.warning || 0, "warning"], ["Critical", summary.critical || 0, "critical"], ["Accounts", summary.accounts || 0, ""], ["Regions", summary.regions || 0, ""]].map(card => <article className="card" key={String(card[0])}><span>{card[0]}</span><strong className={String(card[2])}>{card[1]}</strong></article>)}</section><section className="panel"><div className="panelHead"><h2>Quota details</h2><input aria-label="Filter quotas" placeholder="Filter quotas…" value={filter} onChange={event => setFilter(event.target.value)} /></div><div className="tableWrap"><table><thead><tr><th>Service / quota</th><th>Account</th><th>Region</th><th>Usage</th><th>Status</th><th>Observed</th></tr></thead><tbody>{visible.map(quota => <tr key={quota.quotaId}><td><strong>{quota.serviceCode}</strong><br /><span className="muted">{quota.quotaName || quota.quotaId}</span></td><td>{quota.accountId}</td><td>{quota.region}</td><td>{quota.currentUtilization} / {quota.quotaValue}</td><td><span className={`badge ${state(quota)}`}>{state(quota)}</span></td><td>{quota.timestamp}</td></tr>)}</tbody></table></div></section></main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
