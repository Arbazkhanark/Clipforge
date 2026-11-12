// src/components/InstagramAccounts.tsx

// import type { InstagramAccountCard } from "../server/queries.ts";

// const STATUS_LABELS = { connected: "Connected", token_expired: "Token expired", revoked: "Permissions revoked", disconnected: "Disconnected", unknown: "Unknown account status" } as const;
// const ELIGIBILITY_LABELS = {
//   connected_eligible: "Connected and eligible",
//   not_connected: "Not connected",
//   missing_permissions: "Connected, missing required permissions",
//   unsupported_personal: "Unsupported personal account",
//   unsupported_account_type: "Unknown or unsupported account type",
//   expired_connection: "Expired connection — reconnect required",
//   reconnection_required: "Reconnection required",
// } as const;

// export function InstagramAccountsView({ configured, accounts }: { configured: boolean; accounts: InstagramAccountCard[] }) {
//   return (
//     <>
//       <h1>Instagram</h1>
//       <p className="muted">ClipForge uses Instagram Login only. It never asks for an Instagram password, and it does not publish a Reel from this page.</p>
//       <p role="status">Live publishing is not configured. No publishing worker is running, so a Reel will not be sent.</p>
//       {!configured && <p role="status">Instagram is not configured. The button below will say so instead of sending you to Meta. Create the Meta app yourself and keep the secret out of git.</p>}
//       <form method="post" action="/api/instagram/start">
//         <button type="submit" disabled={!configured}>Connect Instagram</button>
//       </form>
//       <section aria-labelledby="accounts-heading">
//         <h2 id="accounts-heading">Connected accounts</h2>
//         {accounts.length === 0 ? <p>No Instagram account is connected.</p> : (
//           <ul className="card-list">
//             {accounts.map((account) => (
//               <li key={account.id} className="card">
//                 <h3>{account.username ? `@${account.username}` : "Instagram account"}</h3>
//                 <p>Status: {STATUS_LABELS[account.status]}</p>
//                 <p>Publishing eligibility: {ELIGIBILITY_LABELS[account.eligibilityStatus]}</p>
//                 <p>Account type: {account.accountType ?? "Not confirmed"}</p>
//                 <p>Permissions: {account.grantedScopes.length > 0 ? account.grantedScopes.join(", ") : "None stored"}</p>
//                 <p>Token: {account.hasToken ? `Stored on the server${account.tokenExpiresAt ? `, expires ${account.tokenExpiresAt}` : ""}` : "Not stored"}</p>
//                 <form method="post" action="/api/instagram/disconnect">
//                   <input type="hidden" name="accountId" value={account.id} />
//                   <p><label><input type="checkbox" name="confirm" value="yes" required /> Disconnect this account. The token is removed. Videos and cycles stay.</label></p>
//                   <button type="submit">Disconnect</button>
//                 </form>
//               </li>
//             ))}
//           </ul>
//         )}
//       </section>
//     </>
//   );
// }







import type { InstagramAccountCard } from "../server/queries.ts";
import type { InstagramDiagnosticResult, InstagramDiagnosticStageStatus } from "../server/instagram/instagram-diagnostic.ts";

const STATUS_LABELS = {
  connected: "Connected",
  token_expired: "Token expired",
  revoked: "Permissions revoked",
  disconnected: "Disconnected",
  unknown: "Unknown account status",
} as const;

const ELIGIBILITY_LABELS = {
  connected_eligible: "Connected and eligible",
  not_connected: "Not connected",
  missing_permissions: "Missing required permissions",
  unsupported_personal: "Unsupported personal account",
  unsupported_account_type: "Unknown or unsupported account type",
  expired_connection: "Expired connection — reconnect required",
  reconnection_required: "Reconnection required",
} as const;

function getStatusClass(status: InstagramAccountCard["status"]) {
  switch (status) {
    case "connected":
      return "instagram-status-connected";
    case "token_expired":
    case "revoked":
      return "instagram-status-warning";
    case "disconnected":
      return "instagram-status-disconnected";
    default:
      return "instagram-status-unknown";
  }
}

function getEligibilityClass(status: InstagramAccountCard["eligibilityStatus"]) {
  switch (status) {
    case "connected_eligible":
      return "instagram-eligibility-good";
    case "not_connected":
      return "instagram-eligibility-neutral";
    default:
      return "instagram-eligibility-warning";
  }
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle
        cx="12"
        cy="12"
        r="4"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle cx="17.5" cy="6.8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="m9 12 2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle
        cx="12"
        cy="8"
        r="4"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M4 21a8 8 0 0 1 16 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="instagram-info-row">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

export function InstagramAccountsView({
  configured,
  accounts,
  diagnostic,
}: {
  configured: boolean;
  accounts: InstagramAccountCard[];
  diagnostic?: InstagramDiagnosticResult | null;
}) {
  const stageText = (status: InstagramDiagnosticStageStatus) => status === "succeeded" ? "Succeeded" : status === "failed" ? "Failed" : "Not run";
  const outcomeText: Record<InstagramDiagnosticResult["outcome"], string> = {
    profile_identity_verified_diagnostic_only: "Profile identity validated; diagnostic completed without connecting the account",
    long_lived_token_exchange_failed: "Long-lived token exchange failed",
    profile_request_failed: "Profile request failed",
    profile_identity_missing: "Profile identity was missing",
    profile_identity_malformed: "Profile identity was malformed",
  };
  return (
    <main className="instagram-page">
      <div className="instagram-page-inner">
        {/* Page heading */}
        <header className="instagram-page-heading">
          <div>
            <span className="instagram-eyebrow">SOCIAL CONNECTIONS</span>
            <h1>Instagram</h1>
            <p>
              Connect your Instagram account and manage its publishing
              connection from one place.
            </p>
          </div>

          <div className="instagram-heading-icon">
            <InstagramIcon />
          </div>
        </header>

        {diagnostic && (
          <section className="instagram-config-notice" role="status" aria-live="polite">
            <strong>Temporary Instagram OAuth diagnostic</strong>
            <p>{outcomeText[diagnostic.outcome]}</p>
            <ul>
              <li>Authorization code exchange: {stageText(diagnostic.tokenExchange)}</li>
              <li>Cross-response ID comparison: {diagnostic.identityComparison === "matched" ? "Matched" : diagnostic.identityComparison === "mismatched" ? "Mismatched" : "Not performed"}</li>
              <li>Long-lived token exchange: {stageText(diagnostic.longLivedTokenExchange)}</li>
              <li>Profile request: {stageText(diagnostic.profileRequest)}</li>
            </ul>
            <p>No Instagram account was connected and no provider token was saved by this diagnostic.</p>
          </section>
        )}

        {/* Connection hero */}
        <section className="instagram-connect-card">
          <div className="instagram-connect-content">
            <div className="instagram-connect-icon">
              <InstagramIcon />
            </div>

            <div className="instagram-connect-copy">
              <span className="instagram-card-eyebrow">
                INSTAGRAM ACCOUNT
              </span>
              <h2>Connect your Instagram account</h2>
              <p>
                Securely connect your account to manage your Instagram
                publishing connection in ClipForge.
              </p>
            </div>
          </div>

          <form
            method="post"
            action="/api/instagram/start"
            className="instagram-connect-form"
          >
            <button
              type="submit"
              className="instagram-connect-button"
              disabled={!configured}
            >
              <InstagramIcon />
              Connect Instagram
              <span aria-hidden="true">→</span>
            </button>
          </form>

          {!configured && (
            <div className="instagram-config-notice" role="status">
              <span className="instagram-notice-icon">!</span>
              <div>
                <strong>Instagram connection is not configured</strong>
                <p>
                  Configure your Meta app credentials before connecting.
                  Keep your app secret out of your source code repository.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Important publishing information */}
        <section className="instagram-publishing-notice" role="status">
          <div className="instagram-notice-symbol">i</div>
          <div>
            <strong>Live publishing is not available yet</strong>
            <p>
              No publishing worker is running. Connecting an account does
              not mean a Reel will be published.
            </p>
          </div>
          <span className="instagram-notice-badge">Not active</span>
        </section>

        {/* Accounts section */}
        <section className="instagram-accounts-section">
          <div className="instagram-section-heading">
            <div>
              <span className="instagram-eyebrow">YOUR CONNECTIONS</span>
              <h2>Connected accounts</h2>
              <p>
                Manage your linked Instagram accounts and their connection
                details.
              </p>
            </div>

            <span className="instagram-account-count">
              {accounts.length} {accounts.length === 1 ? "account" : "accounts"}
            </span>
          </div>

          {accounts.length === 0 ? (
            <div className="instagram-empty-state">
              <div className="instagram-empty-icon">
                <InstagramIcon />
              </div>
              <h3>No accounts connected</h3>
              <p>
                Your connected Instagram accounts will appear here.
                Connect an account to get started.
              </p>
            </div>
          ) : (
            <div className="instagram-account-grid">
              {accounts.map((account) => (
                <article className="instagram-account-card" key={account.id}>
                  {/* Card header */}
                  <div className="instagram-account-header">
                    <div className="instagram-account-identity">
                      <div className="instagram-account-avatar">
                        <AccountIcon />
                      </div>

                      <div className="instagram-account-name">
                        <h3>
                          {account.username
                            ? `@${account.username}`
                            : "Instagram account"}
                        </h3>
                        <span>Instagram account</span>
                      </div>
                    </div>

                    <span
                      className={`instagram-status-badge ${getStatusClass(
                        account.status
                      )}`}
                    >
                      <span className="instagram-status-dot" />
                      {STATUS_LABELS[account.status]}
                    </span>
                  </div>

                  {/* Eligibility */}
                  <div className="instagram-eligibility-box">
                    <div className="instagram-eligibility-icon">
                      <ShieldIcon />
                    </div>
                    <div>
                      <span>Publishing eligibility</span>
                      <strong
                        className={getEligibilityClass(
                          account.eligibilityStatus
                        )}
                      >
                        {ELIGIBILITY_LABELS[account.eligibilityStatus]}
                      </strong>
                    </div>
                  </div>

                  {/* Account details */}
                  <div className="instagram-account-details">
                    <InfoRow label="Account type">
                      <strong>{account.accountType ?? "Not confirmed"}</strong>
                    </InfoRow>

                    <InfoRow label="Permissions">
                      <span className="instagram-detail-value">
                        {account.grantedScopes.length > 0
                          ? account.grantedScopes.join(", ")
                          : "None stored"}
                      </span>
                    </InfoRow>

                    <InfoRow label="Access token">
                      <span
                        className={
                          account.hasToken
                            ? "instagram-token-stored"
                            : "instagram-token-missing"
                        }
                      >
                        <span className="instagram-status-dot" />
                        {account.hasToken
                          ? "Stored on the server"
                          : "Not stored"}
                      </span>
                    </InfoRow>

                    {account.hasToken && account.tokenExpiresAt && (
                      <InfoRow label="Token expiry">
                        <span className="instagram-detail-value">
                          {account.tokenExpiresAt}
                        </span>
                      </InfoRow>
                    )}
                  </div>

                  {/* Disconnect */}
                  <div className="instagram-disconnect-area">
                    <form
                      method="post"
                      action="/api/instagram/disconnect"
                    >
                      <input
                        type="hidden"
                        name="accountId"
                        value={account.id}
                      />

                      <label className="instagram-disconnect-confirm">
                        <input
                          type="checkbox"
                          name="confirm"
                          value="yes"
                          required
                        />
                        <span>
                          I understand that disconnecting removes the stored
                          token. Videos and publishing cycles stay.
                        </span>
                      </label>

                      <button
                        type="submit"
                        className="instagram-disconnect-button"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M9 6V4h6v2m-9 0h12m-10 0 1 14h6l1-14M10 10v6m4-6v6"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        Disconnect account
                      </button>
                    </form>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Security information */}
        <section className="instagram-security-card">
          <div className="instagram-security-icon">
            <ShieldIcon />
          </div>
          <div>
            <h3>Your account security matters</h3>
            <p>
              ClipForge uses Instagram Login. It never asks you to enter
              your Instagram password on this page.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
