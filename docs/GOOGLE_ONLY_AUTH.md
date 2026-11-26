# Google-only sign-in

ClipForge temporarily offers Google OAuth as the only user sign-in and account-creation method. The login and registration pages use the same Google authorization-code flow. Email/password registration, login, email verification, password reset, and password-based Admin login are disabled by default in both the UI and server runtime. Existing users, password hashes, roles, sessions, and Google identities are not deleted or rewritten.

## Google OAuth configuration

Configure these server-side Vercel environment variables with values from the existing Google OAuth application:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`

`GOOGLE_OAUTH_REDIRECT_URI` must use HTTPS in production and end with `/api/auth/google/callback`. No placeholder or invented credentials should be used.

Google must confirm the email address. ClipForge does not link a Google identity merely because its email matches an existing account. Linking remains available only through the existing authenticated, verified-account flow. A password-only account with no linked Google identity may need support or a future explicitly enabled recovery path before its owner can sign in; its stored account and role are preserved.

## Email/password and SES reactivation

Email delivery and password authentication stay off unless both exact switches are set:

- `CLIPFORGE_EMAIL_ENABLED=true`
- `CLIPFORGE_PASSWORD_AUTH_ENABLED=true`

Both switches are required to re-enable email/password registration, login, verification, password reset, and password-based Admin login. Setting only one does not enable password authentication. Email provider configuration is validated only when an enabled email operation is invoked. A disabled sender returns a fixed unavailable error and never claims that a message was sent.

Production email remains SES-only. To reactivate it, explicitly configure `EMAIL_PROVIDER=ses`, `AWS_REGION`, and `EMAIL_FROM`, and provide AWS credentials through the approved default credential chain/task role. Do not add dummy values or static credentials. Development SMTP and the existing fake test provider remain supported by the existing provider rules. Staging SES delivery continues to require its recipient allowlist.

S3 is independent of these switches. Existing `CLIPFORGE_STORAGE_PROVIDER` and `CLIPFORGE_S3_*` configuration continues to control private media storage; disabling SES does not disable S3 or change storage credentials.
