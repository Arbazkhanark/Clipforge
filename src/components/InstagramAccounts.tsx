import type { InstagramAccountCard } from "../server/queries.ts";

const STATUS_LABELS = { connected: "Connected", token_expired: "Token expired", revoked: "Permissions revoked", disconnected: "Disconnected" } as const;

export function InstagramAccountsView({ configured, accounts }: { configured: boolean; accounts: InstagramAccountCard[] }) {
  return (
    <>
      <h1>Instagram</h1>
      <p className="muted">ClipForge uses Instagram Login only. It never asks for an Instagram password, and it does not publish a Reel from this page.</p>
      <p role="status">Live publishing is not configured. No publishing worker is running, so a Reel will not be sent.</p>
      {!configured && <p role="status">Instagram is not configured. The button below will say so instead of sending you to Meta. Create the Meta app yourself and keep the secret out of git.</p>}
      <form method="post" action="/api/instagram/start">
        <button type="submit">Connect Instagram</button>
      </form>
      <section aria-labelledby="accounts-heading">
        <h2 id="accounts-heading">Connected accounts</h2>
        {accounts.length === 0 ? <p>No Instagram account is connected.</p> : (
          <ul className="card-list">
            {accounts.map((account) => (
              <li key={account.id} className="card">
                <h3>{account.username ? `@${account.username}` : "Instagram account"}</h3>
                <p>Status: {STATUS_LABELS[account.status]}</p>
                <p>Account type: {account.accountType ?? "Not confirmed"}</p>
                <p>Permissions: {account.grantedScopes.length > 0 ? account.grantedScopes.join(", ") : "None stored"}</p>
                <p>Token: {account.hasToken ? `Stored on the server${account.tokenExpiresAt ? `, expires ${account.tokenExpiresAt}` : ""}` : "Not stored"}</p>
                <form method="post" action="/api/instagram/disconnect">
                  <input type="hidden" name="accountId" value={account.id} />
                  <p><label><input type="checkbox" name="confirm" value="yes" required /> Disconnect this account. The token is removed. Videos and cycles stay.</label></p>
                  <button type="submit">Disconnect</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
